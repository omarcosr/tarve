# Deep links e associações de arquivo (TS-first)

Estado: implementado no lado TypeScript para Windows e Linux. No Android, só o manifesto (a entrega do link ao JS depende de código nativo). Nada em `native/src` nem em `scripts/setup-examples.ts` foi alterado.

## O que já existia

- `requestSingleInstance({ id, schemes })` (`packages/core/src/instance.ts`): a primeira instância escuta num named pipe (Windows) ou socket Unix; uma instância posterior envia `{ args, cwd, urls }` em JSON, recebe o pid, chama `tarve_allow_foreground(pid)` e sai. Na primeira instância, `onSecondInstance` recebe esse launch.
- `registerUrlScheme` / `unregisterUrlScheme`, que registravam só o protocolo (HKCU no Windows, `.desktop` + `xdg-mime` no Linux).
- `tarve package` (`packages/core/package-installer.ts`): deb/tar/zip/msix (e agora `app-zip`, do bg-6), sem `MimeType` nem extensões MSIX.

## O que foi feito

### 1. API do app (`src/associations.ts`, `src/app/open-requests.ts`, `src/app.ts`)
- `AppOptions.protocols?: string[]` e `AppOptions.fileTypes?: { ext, name, icon?, mime? }[]`.
- `app.onOpenUrl((url, event) => …)` e `app.onOpenFiles((files, event) => …)`. Cada uma devolve uma função para cancelar o registro. `event = { initial, args, cwd }`.
  - **Launch inicial**: o argv (`process.argv.slice(2)`) chega a cada listener uma vez, num microtask logo depois do registro.
  - **Launches encaminhados**: o `instance.ts` tem agora um canal global `onForwardedLaunch` (`Symbol.for("tarve.forwardedLaunches")`), notificado pelo mesmo `deliver` do `onSecondInstance`. Basta chamar `requestSingleInstance` antes de `createApp`, sem outra ligação manual.
  - Erros dos listeners vão para `onError` com `source: "listener", event: "open"`. Os listeners são descartados quando o app fecha.
- `parseOpenArgs(args, { protocols, fileTypes, cwd })`:
  - URLs: só os esquemas declarados (sem lista, qualquer `x://`).
  - Arquivos: só as extensões declaradas (sem lista, só argumentos que existem como arquivo). `file://…` é convertido em caminho (é o que o `%U` do Linux passa). Caminhos relativos são resolvidos contra o `cwd` do launch.
  - Opções (`-x`, `--x`) são ignoradas, e também o valor depois de um `--tarve-*`.
- `urlsOf`, `quote` e `desktopQuote` passaram para `associations.ts`. `instance.ts` reexporta os três, então a API antiga continua igual.

### 2. Windows
- `registerProtocol` / `unregisterProtocol` / `registerFileType` / `unregisterFileType`, exportados por `@tarve/core`. Usam `reg.exe` em `HKCU\Software\Classes`, por usuário e sem admin.
- Os comandos são gerados por funções puras, testadas sem tocar no registro: `protocolRegistryCommands`, `fileTypeRegistryCommands`, `*UnregistryCommands`, `fileTypeProgId`.
  - Protocolo: `URL:<nome>`, `URL Protocol`, `DefaultIcon` (opcional) e `shell\open\command` = `"exe" ["script"] "%1"`.
  - Tipo de arquivo: ProgID `<appId>.<ext>` com nome, `DefaultIcon` e `shell\open\command`; `.<ext>\OpenWithProgids` (REG_NONE); default de `.<ext>` (`setDefault`, padrão true; a escolha do usuário no UserChoice continua valendo); `Content Type` quando `mime` é explícito.
- `unregisterFileType` só apaga o default da extensão se ele ainda apontar para o nosso ProgID (`reg query`).
- `registerUrlScheme` / `unregisterUrlScheme` agora são aliases de `registerProtocol` / `unregisterProtocol`. O `scripts/smoke-single-instance.tsx` continua válido.
- MSIX: `appxManifest` recebe `protocols` e `fileTypes` e gera `<Extensions>` com `uap:Protocol` e `uap:FileTypeAssociation` (DisplayName, Logo `Assets\FileType-<ext>.png` quando o ícone é PNG, SupportedFileTypes com ContentType).

### 3. Linux
- `.desktop` do deb e do tar: `MimeType=x-scheme-handler/<scheme>;<mime>;…` (o `Exec` já usa `%U`).
- XML shared-mime-info (`mime/packages/<appId>.xml`) para as extensões próprias: tipos sem `mime`, ou com `mime` `x-…`/`vnd.…`. Tipos padrão como `text/markdown` não são redeclarados. O ícone PNG do tipo vai para `icons/hicolor/<n>x<n>/mimetypes/<mime-com-hífen>.png`.
- deb: arquivos em `/usr/share/...`; `postinst`/`postrm` rodam `update-mime-database /usr/share/mime`.
- tar: arquivos em `share/...`; `install.sh` copia para `~/.local/share` e roda `update-mime-database`; `--uninstall` remove tudo.
- Em tempo de execução, `registerFileType` grava o XML em `~/.local/share/mime/packages/tarve-<ext>.xml`, cria um `.desktop` handler e chama `xdg-mime default`.

### 4. Configuração e CLI
- `package.json` → `tarve.protocols: ["myapp"]` e `tarve.fileTypes: [{ "ext": "note", "name": "Note", "icon": "note.png" }]`. `tarve.apps["<entry>"]` também é aceito para apps específicos.
- Quem lê essa configuração é o novo `packages/core/associations-config.ts` (`resolveAppAssociations`, `parseFileTypeFlag`).
- CLI: `--protocol myapp` (repetível; vale para `package` e `build --target android`) e `--file-type ext=Nome` (repetível; vale para `package`).

### 5. Android
- O manifesto é gerado em TS (`packages/core/android-build.ts`, `androidManifest`). Para cada esquema foi adicionado um `<intent-filter>` VIEW/DEFAULT/BROWSABLE com `<data android:scheme>` na NativeActivity (`launchMode="singleTask"`). Os esquemas vêm de `tarve.protocols` e de `--protocol`.
- **Limitação**: o sistema já abre o app pelo link, mas o URL **não chega ao JS**. A NativeActivity não expõe `getIntent().getData()` nem `onNewIntent` ao runtime. Para isso é preciso mudar `native/src/android*.rs` (ou a classe Java em `classes.dex`): ler o Intent no `onCreate`/`onNewIntent` e entregá-lo ao JS como argv inicial ou como evento. Depois disso, basta chamar `opens.dispatch({ args: [url], cwd }, initial)`. Fica para a aba que cuida do Android nativo.
- Associações de arquivo no Android (`content://` + ContentResolver) também precisam de código nativo e não foram adicionadas ao manifesto.
- **Atualização**: as duas limitações acima foram resolvidas. A activity agora é `dev.tarve.TarveActivity`, que lê o Intent no `onCreate` e no `onNewIntent` e entrega o link (ou o documento copiado para o cache) como evento `open`. O manifesto ganhou intent-filters para `fileTypes`. Detalhes em `reports/gap/android-apis.md`.

## Testes
- `packages/core/src/associations.test.ts` (9 testes): normalização, parsing de argv (URLs, caminhos, `file://`, opções `--tarve-*`), comandos de registro e remoção, `MimeType`, shared-mime-info, extensões MSIX, intent-filters Android, entrega inicial e encaminhada de `onOpenUrl`/`onOpenFiles`, canal `onForwardedLaunch` com `requestSingleInstance` real.
- `packages/core/associations-package.test.ts`: leitura do package.json e dos flags; `.desktop` com `MimeType`; deb e tar abertos de volta (data.tar.gz, postinst, install.sh); `AppxManifest` com `uap:Protocol` e `uap:FileTypeAssociation`; `AndroidManifest` com o intent-filter.

## Exemplo
`examples/deep-link/deep-link.tsx`: instância única, `createApp({ protocols, fileTypes })`, botões Registrar/Remover (`registerProtocol` / `registerFileType`) e uma lista de links e arquivos abertos, iniciais ou encaminhados. Não foi adicionado a `examples/package.json`, que está sendo editado por outras abas.

## Limitações e próximos passos
- Windows: depois de `registerFileType`, o Explorer pode demorar para mostrar o novo ícone. Sem código nativo não dá para chamar `SHChangeNotify(SHCNE_ASSOCCHANGED)`.
- MSIX: apps full-trust recebem o URI ou o caminho como argumento de linha de comando. A ativação não foi validada num pacote assinado.
- macOS: `CFBundleURLTypes` e `CFBundleDocumentTypes` no Info.plist, mais os Apple Events (`kAEGetURL`/`openFiles`), dependem do bundle (bg-6) e de código nativo. `registerProtocol` dá erro no macOS.
- `tarve build` não grava `protocols`/`fileTypes` no `TARVE_APP_METADATA` em tempo de execução: o app declara os dele em `createApp`.
