// <video>: the platform decoder plays picture and sound; in a visible window the
// picture is its own composition layer, so playback repaints no UI.
import { Column, Row, Text, View, Window, render } from "@tarve/core";
// Embedded in the executable by `bun run build:video`; extracted once on first launch.
// import film from "../../media/launch-video/tarve-launch.mp4" with { type: "file" };

const film = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4";

const state = { time: 0, duration: 0, size: "" };

function App() {
  return (
    <Window title="Tarve — video" width={1100} height={760} style={{ background: "#0b0b0f" }}>
      <Column style={{ padding: 28, gap: 18, flex: 1 }}>
        <Row style={{ align: "center", gap: 12 }}>
          <Text style={{ fontSize: 22, fontWeight: 700, foreground: "#fafafa" }}>Launch film</Text>
          <Text style={{ fontSize: 13, foreground: "#a1a1aa" }}>{state.size || "loading…"}</Text>
        </Row>
        <View style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <video id="film" src={film} autoPlay muted loop controls
            style={{ width: "100%", height: "100%", radius: 18, background: "#000000" }}
            onLoadedMetadata={info => { state.duration = info.duration ?? 0; state.size = `${info.videoWidth}×${info.videoHeight}`; }}
            onTimeUpdate={info => { state.time = info.currentTime; }} />
          {/* UI over the picture: drawn on top of the video layer. */}
          <View style={{ position: "absolute", left: 18, top: 18, padding: { left: 12, right: 12, top: 6, bottom: 6 }, radius: 999, background: "rgba(0, 0, 0, 0.55)" }}>
            <Text style={{ fontSize: 13, fontWeight: 600, foreground: "#fafafa" }}>● LIVE PREVIEW</Text>
          </View>
        </View>
        <Row style={{ gap: 14, height: 120 }}>
          {(["cover", "contain", "fill"] as const).map(fit => (
            <Column key={fit} style={{ gap: 6, flex: 1 }}>
              <video id={`thumb-${fit}`} src={film} autoPlay muted loop fit={fit}
                style={{ flex: 1, minHeight: 0, radius: 12, background: "#18181b" }} />
              <Text style={{ fontSize: 12, foreground: "#a1a1aa" }}>object-fit: {fit}</Text>
            </Column>
          ))}
        </Row>
      </Column>
    </Window>
  );
}

await render(App, {
  renderer: "cpu"
});
