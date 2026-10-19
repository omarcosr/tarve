#include <windows.h>
#include <d2d1.h>
#include <dwrite.h>
#include <string>
#pragma comment(lib, "d2d1")
#pragma comment(lib, "dwrite")
#pragma comment(lib, "user32")
using namespace D2D1;

ID2D1Factory* factory;
IDWriteFactory* dwrite;
ID2D1HwndRenderTarget* rt;
ID2D1SolidColorBrush *white, *border, *text, *primary, *primaryText;
IDWriteTextFormat *titleFmt, *countFmt, *buttonFmt;
int count = 0;
const D2D1_RECT_F buttonRect = {40, 156, 360, 192};

template <class T> void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }

void CreateDeviceResources(HWND hwnd) {
  if (rt) return;
  RECT rc; GetClientRect(hwnd, &rc);
  float dpi = (float)GetDpiForWindow(hwnd);
  factory->CreateHwndRenderTarget(RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_DEFAULT, PixelFormat(), dpi, dpi),
    HwndRenderTargetProperties(hwnd, SizeU(rc.right, rc.bottom)), &rt);
  rt->CreateSolidColorBrush(ColorF(0xFFFFFF), &white);
  rt->CreateSolidColorBrush(ColorF(0xE4E4E7), &border);
  rt->CreateSolidColorBrush(ColorF(0x09090B), &text);
  rt->CreateSolidColorBrush(ColorF(0x18181B), &primary);
  rt->CreateSolidColorBrush(ColorF(0xFAFAFA), &primaryText);
}

void DiscardDeviceResources() {
  SafeRelease(white); SafeRelease(border); SafeRelease(text);
  SafeRelease(primary); SafeRelease(primaryText); SafeRelease(rt);
}

void Paint(HWND hwnd) {
  CreateDeviceResources(hwnd);
  rt->BeginDraw();
  rt->Clear(ColorF(0xF4F4F5));

  D2D1_ROUNDED_RECT card = {{24.5f, 24.5f, 375.5f, 207.5f}, 8, 8};
  rt->FillRoundedRectangle(card, white);
  rt->DrawRoundedRectangle(card, border, 1.0f);

  rt->DrawText(L"Contador", 8, titleFmt, RectF(40, 40, 360, 68), text);
  std::wstring n = std::to_wstring(count);
  rt->DrawText(n.c_str(), (UINT32)n.size(), countFmt, RectF(40, 80, 360, 144), text);

  rt->FillRoundedRectangle(RoundedRect(buttonRect, 6, 6), primary);
  rt->DrawText(L"Aumentar", 8, buttonFmt, buttonRect, primaryText);

  if (rt->EndDraw() == D2DERR_RECREATE_TARGET) DiscardDeviceResources();
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_PAINT: Paint(hwnd); ValidateRect(hwnd, nullptr); return 0;
    case WM_SIZE: if (rt) rt->Resize(SizeU(LOWORD(lp), HIWORD(lp))); return 0;
    case WM_DPICHANGED: {
      DiscardDeviceResources();
      RECT* r = (RECT*)lp;
      SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER);
      return 0;
    }
    case WM_LBUTTONDOWN: {
      float scale = GetDpiForWindow(hwnd) / 96.0f;
      float x = (short)LOWORD(lp) / scale, y = (short)HIWORD(lp) / scale;
      if (x >= buttonRect.left && x <= buttonRect.right && y >= buttonRect.top && y <= buttonRect.bottom) {
        count++;
        InvalidateRect(hwnd, nullptr, FALSE);
      }
      return 0;
    }
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProc(hwnd, msg, wp, lp);
}

IDWriteTextFormat* Format(float size, DWRITE_FONT_WEIGHT weight) {
  IDWriteTextFormat* f;
  dwrite->CreateTextFormat(L"Segoe UI", nullptr, weight, DWRITE_FONT_STYLE_NORMAL,
                           DWRITE_FONT_STRETCH_NORMAL, size, L"pt-BR", &f);
  return f;
}

int WINAPI wWinMain(HINSTANCE h, HINSTANCE, PWSTR, int show) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, &factory);
  DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), (IUnknown**)&dwrite);
  titleFmt = Format(20, DWRITE_FONT_WEIGHT_BOLD);
  countFmt = Format(42, DWRITE_FONT_WEIGHT_NORMAL);
  buttonFmt = Format(14, DWRITE_FONT_WEIGHT_SEMI_BOLD);
  buttonFmt->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
  buttonFmt->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);

  WNDCLASSW wc = {}; wc.lpfnWndProc = WndProc; wc.hInstance = h;
  wc.lpszClassName = L"ContadorD2D"; wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassW(&wc);

  UINT dpi = GetDpiForSystem();
  RECT r = {0, 0, MulDiv(400, dpi, 96), MulDiv(232, dpi, 96)};
  AdjustWindowRectExForDpi(&r, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi);
  HWND hwnd = CreateWindowW(L"ContadorD2D", L"Contador (Direct2D)", WS_OVERLAPPEDWINDOW,
                            CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left, r.bottom - r.top,
                            nullptr, nullptr, h, nullptr);
  ShowWindow(hwnd, show);

  MSG m;
  while (GetMessage(&m, nullptr, 0, 0)) { TranslateMessage(&m); DispatchMessage(&m); }

  DiscardDeviceResources();
  SafeRelease(titleFmt); SafeRelease(countFmt); SafeRelease(buttonFmt);
  SafeRelease(dwrite); SafeRelease(factory);
  return 0;
}
