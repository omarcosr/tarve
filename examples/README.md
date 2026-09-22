# Exemplos Tarve

Este diretório é um projeto Bun consumidor do pacote npm `tarve`. Os exemplos importam apenas `tarve` e arquivos de mídia locais; o `tsconfig.json` não herda configuração do repositório.

Após a publicação de `tarve@0.1.0`, instale o pacote neste projeto:

```powershell
bun add tarve@0.1.0
bun run check
bun run counter
bun run components
bun run tarve build counter.tsx --outfile dist/Counter.exe
bun run tarve build basic.tsx --outfile dist/Basic.exe
bun run tarve build components.tsx --outfile dist/Components.exe
```

`components` também demonstra `TreeView` e `DataGrid`. `counter` demonstra APIs de desktop que dependem do `AppHandle`: hotkey global (`Ctrl+S`), open/open-multiple/folder/save dialogs nativos e `Window.onCloseRequest` cancelável.

Antes da publicação, rode `bun run pack` na raiz e instale o tarball npm em uma cópia independente desta pasta com `bun add A:/tarve/dist/tarve-0.1.0.tgz`. Na árvore de desenvolvimento, `bun run setup:examples` instala esse mesmo tarball sem gravar uma dependência de caminho local no `package.json` dos exemplos. A verificação `bun run smoke:package` copia os exemplos para uma pasta temporária e compila os cinco executáveis fora do repositório.
