package dev.tarve;

import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.PixelFormat;
import android.graphics.SurfaceTexture;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaPlayer;
import android.net.Uri;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/**
 * `<video>` on Android: the platform's MediaPlayer decodes (hardware codecs where the device
 * has them) and plays the sound in sync; pictures reach an ImageReader as YUV 4:2:0 and go to
 * the runtime (native/src/video/android.rs), which converts them to RGBA for the renderer.
 *
 * Some decoders (Qualcomm's, on Samsung Galaxy phones) fill the reader with their compressed
 * UBWC layout even when CPU reads are asked for, and getPlanes() on such an image makes ART
 * abort the process. On the first such picture the player switches to a GPU copy: the decoder
 * draws into a SurfaceTexture, which is drawn (scaled to at most MAX_SIDE) into an RGBA reader.
 */
public final class TarveVideo {
    static native void nativeFrame(long handle, int width, int height, ByteBuffer y, ByteBuffer u,
        ByteBuffer v, int yRow, int uvRow, int uvPixel);
    static native void nativeFrameRgba(long handle, int width, int height, ByteBuffer rgba, int row);
    static native void nativeEvent(long handle, String event, double value);

    private static final int MAX_SIDE = 1280;

    private final long handle;
    private final MediaPlayer player = new MediaPlayer();
    private final HandlerThread thread = new HandlerThread("tarve-video");
    private final Handler handler;
    private ImageReader reader;
    private GpuCopy gpu;
    private volatile boolean prepared, wantPlay, looped, released;

    public TarveVideo(Context context, long handle, String src, boolean looped, boolean muted, float volume) throws Exception {
        this.handle = handle;
        this.looped = looped;
        thread.start();
        handler = new Handler(thread.getLooper());
        player.setLooping(looped);
        setVolume(muted, volume);
        player.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
            @Override public void onPrepared(MediaPlayer mp) { onReady(); }
        });
        player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
            @Override public void onCompletion(MediaPlayer mp) { if (!TarveVideo.this.looped) nativeEvent(TarveVideo.this.handle, "ended", 0); }
        });
        player.setOnSeekCompleteListener(new MediaPlayer.OnSeekCompleteListener() {
            @Override public void onSeekComplete(MediaPlayer mp) { nativeEvent(TarveVideo.this.handle, "seeked", 0); }
        });
        player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
            @Override public boolean onError(MediaPlayer mp, int what, int extra) {
                nativeEvent(TarveVideo.this.handle, "error", what);
                return true;
            }
        });
        if (src.contains("://")) player.setDataSource(context, Uri.parse(src));
        else player.setDataSource(src);
        player.prepareAsync();
    }

    private void onReady() {
        if (released) return;
        final int width = player.getVideoWidth(), height = player.getVideoHeight();
        if (width > 0 && height > 0) {
            reader = Build.VERSION.SDK_INT >= 29
                ? ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 3, android.hardware.HardwareBuffer.USAGE_CPU_READ_OFTEN)
                : ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 3);
            reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override public void onImageAvailable(ImageReader r) {
                    Image image;
                    try { image = r.acquireLatestImage(); } catch (IllegalStateException e) { return; }
                    if (image == null) return;
                    try {
                        if (!mappable(image)) {
                            if (gpu == null) switchToGpu(width, height);
                            return;
                        }
                        Image.Plane[] planes = image.getPlanes();
                        nativeFrame(TarveVideo.this.handle, image.getWidth(), image.getHeight(), planes[0].getBuffer(), planes[1].getBuffer(),
                            planes[2].getBuffer(), planes[0].getRowStride(), planes[1].getRowStride(), planes[1].getPixelStride());
                    } finally {
                        image.close();
                    }
                }
            }, handler);
            player.setSurface(reader.getSurface());
        }
        prepared = true;
        nativeEvent(handle, "loadedmetadata", player.getDuration() / 1000.0);
        if (wantPlay) player.start();
    }

    /** On the reader's thread: the decoder's pictures go through the GPU from now on. */
    private void switchToGpu(int width, int height) {
        try {
            gpu = new GpuCopy(width, height);
            player.setSurface(gpu.input);
            final ImageReader old = reader;
            reader = null;
            handler.post(new Runnable() { @Override public void run() { old.close(); } });
        } catch (RuntimeException error) {
            android.util.Log.e("tarve", "video: no readable picture path on this device", error);
            if (gpu != null) gpu.release();
            gpu = null;
            player.setSurface(null);
            nativeEvent(handle, "error", -1);
        }
    }

    public void play() { wantPlay = true; if (prepared) player.start(); }
    public void pause() { wantPlay = false; if (prepared) player.pause(); }
    public void seek(double seconds) { if (prepared) player.seekTo((long) (seconds * 1000), MediaPlayer.SEEK_CLOSEST); }
    public void set(boolean looped, boolean muted, float volume) {
        this.looped = looped;
        player.setLooping(looped);
        setVolume(muted, volume);
    }
    public double position() { return prepared ? player.getCurrentPosition() / 1000.0 : 0; }
    public int width() { return prepared ? player.getVideoWidth() : 0; }
    public int height() { return prepared ? player.getVideoHeight() : 0; }

    public void release() {
        released = true;
        player.release();
        handler.post(new Runnable() {
            @Override public void run() {
                if (reader != null) reader.close();
                if (gpu != null) gpu.release();
                thread.quitSafely();
            }
        });
    }

    /** Standard YUV layouts only; a vendor layout cannot be mapped (see the class comment). */
    private static boolean mappable(Image image) {
        if (Build.VERSION.SDK_INT < 28) return true;
        android.hardware.HardwareBuffer buffer = image.getHardwareBuffer();
        if (buffer == null) return true;
        try {
            int format = buffer.getFormat();
            // HAL_PIXEL_FORMAT_YCbCr_420_888, YCrCb_420_SP (NV21), YV12, YCbCr_420_SP (NV12).
            return format == 0x23 || format == 0x11 || format == 0x32315659 || format == 0x15;
        } finally {
            buffer.close();
        }
    }

    private void setVolume(boolean muted, float volume) {
        float level = muted ? 0f : volume;
        player.setVolume(level, level);
    }

    /** Decoder → SurfaceTexture → one textured quad → RGBA ImageReader, all on the video thread. */
    private final class GpuCopy {
        final Surface input;
        private final SurfaceTexture texture;
        private final ImageReader output;
        private final EGLDisplay display;
        private final EGLContext context;
        private final EGLSurface surface;
        private final int program, texId, outWidth, outHeight;
        private final float[] matrix = new float[16];
        private final FloatBuffer quad;

        GpuCopy(int width, int height) {
            int step = (Math.max(width, height) + MAX_SIDE - 1) / MAX_SIDE;
            outWidth = (width + step - 1) / step;
            outHeight = (height + step - 1) / step;
            output = Build.VERSION.SDK_INT >= 29
                ? ImageReader.newInstance(outWidth, outHeight, PixelFormat.RGBA_8888, 2,
                    android.hardware.HardwareBuffer.USAGE_CPU_READ_OFTEN | android.hardware.HardwareBuffer.USAGE_GPU_COLOR_OUTPUT)
                : ImageReader.newInstance(outWidth, outHeight, PixelFormat.RGBA_8888, 2);
            output.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override public void onImageAvailable(ImageReader r) {
                    Image image;
                    try { image = r.acquireLatestImage(); } catch (IllegalStateException e) { return; }
                    if (image == null) return;
                    try {
                        Image.Plane plane = image.getPlanes()[0];
                        nativeFrameRgba(handle, image.getWidth(), image.getHeight(), plane.getBuffer(), plane.getRowStride());
                    } finally {
                        image.close();
                    }
                }
            }, handler);

            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
            int[] version = new int[2];
            if (!EGL14.eglInitialize(display, version, 0, version, 1)) throw new RuntimeException("eglInitialize");
            int[] attributes = {
                EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT, EGL14.EGL_NONE,
            };
            EGLConfig[] configs = new EGLConfig[1];
            int[] count = new int[1];
            if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) || count[0] == 0) throw new RuntimeException("eglChooseConfig");
            context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, new int[] { EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE }, 0);
            if (context == EGL14.EGL_NO_CONTEXT) throw new RuntimeException("eglCreateContext");
            surface = EGL14.eglCreateWindowSurface(display, configs[0], output.getSurface(), new int[] { EGL14.EGL_NONE }, 0);
            if (surface == EGL14.EGL_NO_SURFACE) throw new RuntimeException("eglCreateWindowSurface");
            if (!EGL14.eglMakeCurrent(display, surface, surface, context)) throw new RuntimeException("eglMakeCurrent");

            program = link(
                "attribute vec2 p; uniform mat4 m; varying vec2 t;\n"
                    + "void main() { gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); t = (m * vec4(p, 0.0, 1.0)).xy; }",
                "#extension GL_OES_EGL_image_external : require\nprecision mediump float; varying vec2 t; uniform samplerExternalOES s;\n"
                    + "void main() { gl_FragColor = vec4(texture2D(s, t).rgb, 1.0); }");
            int[] ids = new int[1];
            GLES20.glGenTextures(1, ids, 0);
            texId = ids[0];
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
            quad = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
            quad.put(new float[] { 0, 0, 1, 0, 0, 1, 1, 1 }).position(0);

            texture = new SurfaceTexture(texId);
            texture.setDefaultBufferSize(width, height);
            texture.setOnFrameAvailableListener(new SurfaceTexture.OnFrameAvailableListener() {
                @Override public void onFrameAvailable(SurfaceTexture st) { draw(); }
            }, handler);
            input = new Surface(texture);
        }

        private void draw() {
            if (released) return;
            EGL14.eglMakeCurrent(display, surface, surface, context);
            texture.updateTexImage();
            texture.getTransformMatrix(matrix);
            GLES20.glViewport(0, 0, outWidth, outHeight);
            GLES20.glUseProgram(program);
            int position = GLES20.glGetAttribLocation(program, "p");
            GLES20.glEnableVertexAttribArray(position);
            GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 0, quad);
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "m"), 1, false, matrix, 0);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId);
            GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "s"), 0);
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
            EGL14.eglSwapBuffers(display, surface);
        }

        void release() {
            input.release();
            texture.release();
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            EGL14.eglDestroySurface(display, surface);
            EGL14.eglDestroyContext(display, context);
            output.close();
        }

        private int link(String vertex, String fragment) {
            int program = GLES20.glCreateProgram();
            GLES20.glAttachShader(program, compile(GLES20.GL_VERTEX_SHADER, vertex));
            GLES20.glAttachShader(program, compile(GLES20.GL_FRAGMENT_SHADER, fragment));
            GLES20.glLinkProgram(program);
            int[] ok = new int[1];
            GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, ok, 0);
            if (ok[0] == 0) throw new RuntimeException("link: " + GLES20.glGetProgramInfoLog(program));
            return program;
        }

        private int compile(int type, String source) {
            int shader = GLES20.glCreateShader(type);
            GLES20.glShaderSource(shader, source);
            GLES20.glCompileShader(shader);
            int[] ok = new int[1];
            GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, ok, 0);
            if (ok[0] == 0) throw new RuntimeException("shader: " + GLES20.glGetShaderInfoLog(shader));
            return shader;
        }
    }
}
