# macOS / iOS — viabilidade e plano

Status: **estudo concluído; M0 (compilação cruzada) verificado.**

## Resultado verificado

- `bun scripts/check-apple.ts` (novo) roda `cargo check` do `native/` para `aarch64-apple-darwin` e `x86_64-apple-darwin` a partir do Windows, usando `zig cc` para os build scripts C (`ring`, `onig_sys`, `libmimalloc-sys`). Não precisa do SDK do Xcode.
- **Os dois alvos macOS compilam.** Os únicos avisos do próprio crate são 2 imports não usados em `native/src/tray.rs:16-17`; o restante dos avisos vem de `vendor/vello`.
- `aarch64-apple-ios` falha nos headers C (`TargetConditionals.h` e `stdlib.h`): o `zig` não inclui o SDK do iOS. Para avançar, é preciso um runner macOS ou trocar as dependências C (`ring` via `ureq`/`rustls` → `rustls` com `aws-lc`/plataforma; `onig` → `fancy-regex` no `syntect`).

Conclusão: o caminho de renderização (winit + wgpu/Metal + Vello, `softbuffer`) já compila para macOS. O que falta é a integração com o sistema e com o lado TypeScript, não a arquitetura.

## Inventário

| Recurso | Onde | Win/Linux hoje | macOS | Esforço |
|---|---|---|---|---|
| Alvo de build/host | `packages/core/targets.ts:1-30`, `packages/core/src/bridge/runtime.ts:29-32` | só `win32`/`linux` | adicionar `darwin-arm64`/`darwin-x64`, `.dylib`, os campos `os`/`cpu` no `package.json` | S |
| Janela + render GPU | `native/src/renderer.rs` | D3D11 (Win), Vello/wgpu (Linux) | Vello/wgpu → Metal (já compila) | S–M |
| Render CPU/transparência | `native/src/renderer.rs:675-687` | softbuffer com alpha | softbuffer **sem alpha** no macOS → janela transparente só via GPU | M |
| Barra de título custom | `native/src/runtime.rs` | Win32 hit-test / winit | `with_titlebar_transparent` + `fullsize_content_view` do winit | M |
| Glass/vibrancy | `native/src/glass.rs` | shader próprio | funciona; opcional `NSVisualEffectView` | S (opcional M) |
| Acessibilidade | `native/src/lib.rs:16-23` | AccessKit UIA / AT-SPI | `accesskit_macos` (adapter oficial) | M |
| Diálogos de arquivo | `native/src/runtime.rs:20-72` | `rfd` | `rfd` já suporta macOS: liberar o cfg | S |
| Clipboard | `native/src/runtime/clipboard.rs:5-14,32-52` | `arboard` | `arboard` ok; atalhos com **Cmd** em vez de Ctrl | S |
| Atalhos de edição | `native/src/runtime.rs` (`word_modifier`, `editing_shortcut`) | Ctrl | Cmd/Option (padrões macOS) | M |
| Menu bar | `native/src/menu_bar.rs:1-3,36` | Win32 | `NSMenu` (`muda` ou `objc2-app-kit`); menu de app obrigatório | M |
| Tray | `native/src/tray.rs:1-14` | Win32 / ksni | `NSStatusItem` (`tray-icon` ou `objc2`) | M |
| Notificações | `native/src/notification.rs:163-167` | WinRT toast / D-Bus | `UNUserNotificationCenter` (exige bundle `.app` assinado) | M |
| Hotkeys globais | `native/src/runtime/system_requests.rs` | RegisterHotKey / X11 | `CGEventTap` ou Carbon `RegisterEventHotKey` | M |
| Mídia / vídeo | `native/src/video/mod.rs:4-17,46-59` | Media Foundation / ffmpeg-like | AVFoundation (`AVPlayer` + `CVPixelBuffer` → textura Metal) | L |
| Now Playing | `native/src/lib.rs:60-61` (SMTC) | SMTC / MPRIS | `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` | M |
| Instância única | runtime | mutex nomeado / socket Unix | socket Unix já existe (`native/src/bridge.rs:155-205`) | S |
| Auto-update | `packages/core/src/updates.ts:208-218,301-327` | PE/ELF, rename+chmod | Mach-O dentro de `.app`; trocar o bundle inteiro, preservando a assinatura | M |
| `tarve build` | `packages/core/build.ts`, `windows-executable.ts` | `.exe`/ELF com runtime embutido | gerar `.app` (Info.plist, ícone `.icns`, `.dylib` em `Contents/Frameworks`) | M |
| Assinatura/notarização | — | `tarve release --sign` (Authenticode) | `codesign --options runtime` + `notarytool` + staple | M |

## Bloqueios

1. Validação em runtime exige hardware Mac ou runner macOS (GitHub Actions `macos-14` arm64 / `macos-13` x64).
2. Notificações, vídeo e update exigem um bundle `.app`, então a M4 fica parcialmente acoplada à M3.
3. iOS: lifecycle `UIApplication`, host JS (Bun não roda no iOS → caminho QuickJS, como no Android `native/src/android/qjs.rs`) e SDK.

## Plano em fases

- **M0 — compila** ✅ `scripts/check-apple.ts`.
- **M1 — janela + render:** alvos em `targets.ts`/`runtime.ts`, build da `.dylib`, carregamento via FFI no Bun/Node, render Vello/Metal, DPI Retina. CI: job `macos-14` com `cargo test` + smoke da janela.
- **M2 — entrada, texto, a11y:** mapeamento Cmd/Option, IME (winit), `accesskit_macos`, rfd, clipboard.
- **M3 — sistema:** NSMenu (menu de app), NSStatusItem, notificações, hotkeys, Now Playing, AVFoundation.
- **M4 — distribuição:** `.app`, `.icns`, codesign, notarização, update preservando a assinatura, DMG/zip.
- **iOS (depois):** reutilizar a arquitetura do Android (host QuickJS, toque, teclado virtual, safe areas); trocar `ring`/`onig` para compilar sem a toolchain C do SDK.

## O que dá para fazer a partir do Windows

- `bun scripts/check-apple.ts` como portão de regressão de compilação (pode entrar no `verify`).
- Todo o lado TS (alvos, `.app` builder, Info.plist, `.icns`) com testes de estrutura, como os do `.deb` em `packages/core/package-installer.test.ts`.
- Execução, assinatura e notarização: só em runner macOS.
