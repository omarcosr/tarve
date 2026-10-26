package dev.tarve;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * `app.webSignIn(...)` on Android: a sign-in page (Google, an OAuth provider) in the system
 * WebView, inside the app. Once the cookies the app waits for exist for `cookieUrl`, the
 * activity returns that URL's Cookie header to the runtime and finishes; Back on the first page
 * cancels. Each sign-in starts from an empty cookie jar, so it never reuses an old session.
 */
public final class TarveWebSignIn extends Activity {
    static native void nativeResult(String requestId, String cookie);

    private String requestId, cookieUrl;
    private String[] cookies;
    private boolean done;
    private WebView web;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestId = getIntent().getStringExtra("requestId");
        cookieUrl = getIntent().getStringExtra("cookieUrl");
        cookies = getIntent().getStringArrayExtra("cookies");
        String url = getIntent().getStringExtra("url");
        if (requestId == null || cookieUrl == null || url == null) {
            finish();
            return;
        }
        CookieManager manager = CookieManager.getInstance();
        manager.setAcceptCookie(true);
        manager.removeAllCookies(null);
        web = new WebView(this);
        manager.setAcceptThirdPartyCookies(web, true);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Google refuses sign-in in a page that announces an embedded WebView ("; wv").
        settings.setUserAgentString(settings.getUserAgentString().replace("; wv)", ")"));
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                check();
            }
            @Override public void onPageFinished(WebView view, String url) {
                check();
            }
            @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                check();
            }
        });
        setContentView(web);
        web.loadUrl(url);
    }

    private void check() {
        if (done) return;
        String header = CookieManager.getInstance().getCookie(cookieUrl);
        if (header == null) return;
        for (String name : cookies == null ? new String[0] : cookies) {
            if (("; " + header).contains("; " + name + "=")) {
                CookieManager.getInstance().flush();
                finishWith(header);
                return;
            }
        }
    }

    private void finishWith(String cookie) {
        if (done) return;
        done = true;
        nativeResult(requestId, cookie);
        finish();
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else finishWith(null);
    }

    @Override protected void onDestroy() {
        finishWith(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
