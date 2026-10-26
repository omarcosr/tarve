# APIs de plataforma no Android (e equivalentes no desktop)

Estado: deep links, compartilhamento, localização e biometria foram implementados no Android e no Windows. No Linux respondem `{ supported: false }`. Push/FCM não foi implementado (o plano está no fim). Protocolo 59 → **60** (TS, Rust e Go).

## O que foi feito

### 1. Deep links e arquivos no Android
- A activity do manifesto agora é **`dev.tarve.TarveActivity`** (`packages/core/android/java/dev/tarve/TarveActivity.java`), uma subclasse de `NativeActivity`. Continua `singleTask`, com o mesmo `lib_name` e o mesmo filtro LAUNCHER, então o `getLaunchIntentForPackage` do `TarveNotificationOpen` e o `restart_process` resolvem para ela. Conferido com `cmd package resolve-activity` e `monkey`.
  - `onCreate` (só sem estado salvo) lê o Intent da abertura. `onNewIntent` faz `setIntent` e lê os Intents seguintes.
  - `ACTION_VIEW` com URL comum: o link vai como está.
  - `content://` ou `file://`: o documento é copiado numa thread para `cache/opened/<hash>/<nome de exibição>`, e o caminho copiado é o que se entrega. Um `file://` legível é entregue direto.
  - O que chega antes do runtime existir fica numa fila em Java. `tarve_start` (`native/src/bridge.rs`, depois de soltar o lock do host) chama `android::open_intent::attach()`, que registra `nativeOpen` via `RegisterNatives` e esvazia a fila. Fora do processo da activity (filho do host Bun) é no-op.
- Rust: `native/src/android/open_intent.rs` emite `{ type: "open", urls, files, initial }` na fila de eventos.
- TS: `app.ts` passa o evento a `opens.deliver()` (`app/open-requests.ts`), sem passar por `parseOpenArgs`, porque o manifesto já filtrou.
  - Os links da própria abertura (`initial: true`) também são reentregues a listeners registrados depois, uma vez cada, como o argv no desktop.
  - Os links seguintes chegam com `initial: false`.
- Manifesto (`android-build.ts`):
  - `androidFileIntentFilters(fileTypes)` (`src/associations.ts`) gera filtros VIEW `content`/`file`: por `mimeType` quando o tipo declara um, senão por `pathPattern` `.*\\.ext`.
  - `tarve build --target android` agora passa os `fileTypes` de `package.json`.
- Correção: `src/associations.ts` importava `node:url` (`fileURLToPath`), que o runtime QuickJS não tem. **Qualquer** build Android QuickJS falhava com "This app reaches APIs the Android runtime does not provide". Foi trocado por `fileUrlPath()` local, com testes.

### 2. Compartilhar: `share({ title?, text?, url?, files? })`
- Funções exportadas por `@tarve/core` (`src/device.ts`, que agem no app ativo) e também métodos em `AppHandle`: `app.share`, `app.getCurrentPosition`, `app.watchPosition`, `app.authenticate`.
- Comando `share` → evento `share { supported, error? }`. A promise resolve quando a folha aparece.
- Android: `TarveShare.java` cria `ACTION_SEND` (texto, ou um arquivo) ou `ACTION_SEND_MULTIPLE` dentro de `Intent.createChooser`. O `url` é anexado ao texto e o `title` vai em `EXTRA_SUBJECT`/`EXTRA_TITLE`.
  - Os arquivos saem por `TarveFileProvider.java`, um ContentProvider próprio sem AndroidX: não exportado, com `grantUriPermissions`, URI `content://<pacote>.tarve.files/<uuid>/<nome>`, somente leitura e só para os arquivos passados a `share`. A concessão vai em `ClipData` e `FLAG_GRANT_READ_URI_PERMISSION`.
- Windows: UI de compartilhamento via `IDataTransferManagerInterop::GetForWindow`/`ShowShareUIForWindow` (`native/src/device.rs`).
  - `DataRequested` preenche título, texto, `WebLink` e `SetStorageItemsReadOnly`. Os `StorageFile` são resolvidos antes, e os itens cruzam a thread num `AgileReference`.
  - O handler de um compartilhamento é trocado no seguinte.
- Linux: `{ supported: false }`.

### 3. Localização: `getCurrentPosition({ highAccuracy, timeoutMs, maximumAgeMs })` e `watchPosition(cb, { highAccuracy })`
- Fluxo no TS (`src/app/device.ts`): primeiro `permissions("request", ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"])`, pelo `TarvePermissions` que já existia. O desktop responde "granted" na hora. Se nenhuma das duas for concedida, o resultado é `{ supported: true, code: "denied" }` e nenhum comando é enviado.
- Comando `location { action: "get" | "watch" | "clear" }`. O "get" responde com `location`. O "watch" responde com eventos `position { watchId }` até o "clear" (é o que a função devolvida por `watchPosition` envia).
- Resultado: `{ supported, position?: { latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed, timestamp }, code?: "unsupported" | "denied" | "unavailable" | "timeout", error? }`.
- Android (`TarveLocation.java`), sobre o `LocationManager` do framework, sem Play Services:
  - Provedores: fused (API 31+) e network. GPS entra quando `highAccuracy` é pedido, ou quando é o único ligado.
  - `maximumAgeMs` aceita a última posição conhecida, se for recente o bastante.
  - O timeout é feito com um `Handler`. O watch recebe atualizações a cada 1 s.
- **As permissões de localização não entram por padrão** no manifesto. O app as declara em `tarve.android.permissions` ou com `--permission`.
- Windows: `Geolocator` numa thread.
  - `RequestAccessAsync` e depois `GetGeopositionAsyncWithAgeAndTimeout`. Para `highAccuracy` usa `PositionAccuracy::High`.
  - O watch usa `PositionChanged` com `ReportInterval` de 1 s.
  - Mapeamento de erros: `E_ACCESSDENIED` → denied, `ERROR_TIMEOUT` → timeout.
- Linux: `unsupported`. O GeoClue fica para depois.

### 4. Biometria: `authenticate({ reason })`
- Comando `authenticate` → evento `authenticate { supported, success, code?: "unsupported" | "not-enrolled" | "canceled" | "failed" | "lockout" | "busy", error? }`.
- Android (`TarveBiometric.java`): `android.hardware.biometrics.BiometricPrompt` do framework, sem AndroidX.
  - API 30+: `BIOMETRIC_WEAK | DEVICE_CREDENTIAL`, com `BiometricManager.canAuthenticate` antes.
  - API 29: `setDeviceCredentialAllowed`.
  - API 28: botão Cancelar.
  - Abaixo de 28: `unsupported`.
  - `USE_BIOMETRIC` (permissão normal, concedida na instalação) entrou em `DEFAULT_ANDROID_PERMISSIONS`.
- Windows: Windows Hello via `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd)`. O resultado é esperado numa thread: Verified, DeviceNotPresent, NotConfiguredForUser, Canceled etc. viram os códigos acima.
- Linux: `unsupported`.

### Protocolo e nativo
- `packages/protocol/src/index.ts`, `native/src/protocol.rs` + `protocol/requests.rs`, `go/tarve/app.go`: versão 60, comandos `share`, `location`, `authenticate` e eventos `share`, `location`, `position`, `authenticate`, `open`. Novos tipos `GeoPosition`, `GeoErrorCode`, `AuthErrorCode`.
- `native/src/device.rs`: o despacho por plataforma, os formatos únicos das respostas e a implementação WinRT.
- `native/src/android/device.rs`: as chamadas JNI para as classes Java.
- `runtime/system_requests.rs` e `runtime.rs`: três braços novos no `match` de comandos. `sync_control_flow` e `about_to_wait` não foram tocados.
- `Cargo.toml` (Windows):
  - Features `ApplicationModel_DataTransfer`, `Devices_Geolocation`, `Foundation_Collections`, `Security_Credentials_UI` e `Storage` do `windows` 0.61.3.
  - Dependências diretas `windows-future =0.2.1` e `windows-collections =0.2.0`, que já estavam na árvore. Nenhum crate novo foi baixado.
- `android/permissions.rs`: `load_class` e `strings` passaram a `pub(crate)`, para reuso.

## Verificação
- `cargo clippy --manifest-path native/Cargo.toml --all-targets` (Windows): sem avisos no `tarve_native`.
- `cargo ndk -t arm64-v8a clippy --lib`: sem avisos nos arquivos novos.
- `cargo test --lib device::`: 2 testes, parsing dos comandos e formato das respostas.
- `bun scripts/build-android.ts --abi arm64-v8a` e `--abi x86_64`: OK (19,7 e 22,7 MiB).
- `bun test packages/core`: 537 passam e 2 falham, ambas em `build.test.ts` (alvo `darwin-arm64` sem diretório nativo empacotado, do trabalho de macOS de outra aba; nada a ver com esta mudança).
  - Os testes Node SEA/dev passam depois de `bun run build:native`, que foi necessário por causa da versão do protocolo.
  - Testes novos:
    - `src/device.test.tsx` (5): share, get, watch, authenticate e eventos `open` iniciais e seguintes.
    - `fileUrlPath` em `associations.test.ts`.
    - Manifesto (`TarveActivity`, provider, `USE_BIOMETRIC`, filtros de arquivo) em `android-build.test.ts`.
- `bun run check` (tsc): OK. `go test ./tarve/`: OK.
- Smoke no emulador x86_64 (Docker, `localhost:5555`) com `scripts/smoke-android-apis.tsx` (comandos de build no topo do arquivo):
  - `am start -a VIEW -d myapp://test` a frio → `open-url myapp://test initial=true`. Um segundo `am start` com o app aberto → `open-url myapp://second?x=1 initial=false` (via `onNewIntent`).
  - `content://media/external/file/…` (`--grant-read-uri-permission`), a quente e a frio → `open-files /data/user/0/dev.tarve.apismoke/cache/opened/…/hello.txt`, com `initial` correto.
  - Share de texto: chooser com título, texto e URL. Share de arquivo: chooser "Sharing 1 file", com o nome lido pelo provider. Ambos → `{ supported: true }`.
  - Localização: sem permissão no manifesto → `denied`. Com permissão e sem fix → `timeout` após 10 s. Com provedor de teste GPS (`cmd location providers …`) → a posição foi recebida, -23,55/-46,63, accuracy 20.
  - Biometria: sem bloqueio de tela → `not-enrolled`. Com PIN (`locksettings set-pin`) e o PIN digitado no prompt → `{ supported: true, success: true }`. O PIN e o mock de localização foram removidos depois.

## Limitações
- Windows: share, Geolocator e Hello **compilam e passam no clippy, mas não foram exercitados interativamente** (abririam UI do sistema na máquina). Em apps não empacotados, a localização depende de "Permitir que apps da área de trabalho acessem sua localização".
- `share` resolve quando a folha aparece. Ele não informa se o usuário concluiu nem qual app escolheu, nem no Android nem no Windows.
- O caminho `restart_process` (activity recriada num processo já usado) reabre pelo intent do launcher, e um link que chegue exatamente nesse caso se perde. O caso comum (processo novo, ou app vivo via `onNewIntent`) funciona.
- Filtros de arquivo sem `mime` usam `pathPattern`, que só casa quando o URI termina no nome do arquivo. Muitos gerenciadores mandam `application/octet-stream` sem nome no caminho. Declarar `mime` é o recomendado.
- Documentos abertos ficam copiados em `cache/opened/` (o sistema pode limpar). Não há escrita de volta no documento original.
- Apps Go no Android recebem os eventos `open`/`position`/`authenticate`, mas `go/tarve` ainda não expõe uma API para eles. Só a versão do protocolo foi atualizada.
- Linux: tudo `{ supported: false }` (share por portal xdg e GeoClue seriam os próximos passos).

## Plano para push (FCM): não implementado
1. Exige um projeto Firebase: o `google-services.json` do app (`project_id`, `mobilesdk_app_id`, `api_key`, `gcm_sender_id`) entra no build via `package.json` `tarve.android.firebase` ou `--firebase <arquivo>`. `android-build.ts` gera os recursos `values/google-services.xml` correspondentes.
2. Cliente sem Gradle/AndroidX: usar o `firebase-messaging` AAR exige dex extra e merge de manifesto. A alternativa mais leve é dexar `firebase-messaging` + `firebase-installations` + `play-services-cloud-messaging` (dependem do Google Play Services no aparelho) com d8 em `compileJava`, mais um `TarveMessagingService extends FirebaseMessagingService` (`onNewToken`, `onMessageReceived`) e `POST_NOTIFICATIONS`, que já está no manifesto.
3. API: `app.pushToken(): Promise<{ supported, token? }>`, `app.onPushToken(cb)` e `app.onPush(cb)`, com os eventos `pushToken`/`push` pelo mesmo canal `emit` usado aqui (fila em Java até o `attach`, como em `TarveActivity`). Uma mensagem com o app fechado mostra a notificação pelo `TarveNotifications`, e o toque abre o app com o payload no Intent (`initial`).
4. Windows: WNS (`PushNotificationChannelManager`) só para apps empacotados (MSIX). Linux: sem equivalente padrão. Ambos responderiam `{ supported: false }` no começo.
5. Testes: unitários com bridge falsa, e smoke no emulador com imagem `google_apis` (que tem Play Services) usando a API HTTP v1 do FCM com uma conta de serviço do projeto de teste.
