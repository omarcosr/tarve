# Comparativo de desempenho entre bibliotecas de interface gráfica

A mesma tela implementada no Tarve e em 5 outras bibliotecas de interface (Electron, Tauri, Flutter, Dioxus Native, egui). Todos foram medidos de fora do processo, exatamente do mesmo jeito.

- **Data:** 2026-11-20 · mediana de 5 execuções por app e por cena · **menor é melhor em todas as métricas**
- **Máquina:** Intel Core Ultra 7 255HX, RTX 5070 Laptop, 31 GB, Windows 11 Insider 26340, escala 125%, 240 Hz
- **Versões:** Tarve 0.13.6 (Bun 1.4.4, Node 26.10, txiki), Electron 45.4.1 + React 19.3, Tauri 2.12 (WebView2 157) + React 19.3, Flutter 3.50.1, Dioxus Native 0.7.10, egui/eframe 0.33
- **Variantes do Tarve:** motor JavaScript Bun, Node ou txiki; desenho padrão na GPU (`auto`, D3D11) ou opção `lowPower` (desenho na CPU).

## Resumo

| # | Métrica | 1º lugar | Melhor Tarve | Posição do Tarve |
| ---: | --- | --- | --- | :---: |
| 1 | [Tamanho em disco](#1-tamanho-em-disco) | egui · 3,5 MB | Tarve · txiki · 11,5 MB | 3º de 11 |
| 2 | [Primeiro quadro, tela vazia](#2-primeiro-quadro-tela-vazia) | Tarve · txiki `lowPower` · 124 ms | Tarve · txiki `lowPower` · 124 ms | 1º de 11 |
| 3 | [Primeiro quadro, 2.000 linhas](#3-primeiro-quadro-2000-linhas) | Tarve · Bun `lowPower` · 212 ms | Tarve · Bun `lowPower` · 212 ms | 1º de 11 |
| 4 | [RAM ociosa, tela vazia](#4-ram-ociosa-tela-vazia) | Tarve · txiki `lowPower` · 18,5 MB | Tarve · txiki `lowPower` · 18,5 MB | 1º de 11 |
| 5 | [RAM ociosa, 2.000 linhas](#5-ram-ociosa-2000-linhas) | egui · 65,9 MB | Tarve · txiki `lowPower` · 87,9 MB | 2º de 11 |
| 6 | [Memória de GPU](#6-memoria-de-gpu) | Tarve · Bun `lowPower` · 0 MB | Tarve · Bun `lowPower` · 0 MB | 1º de 11 |
| 7 | [CPU durante a rolagem](#7-cpu-durante-a-rolagem) | Tarve · txiki · 24,3 % de 1 núcleo | Tarve · txiki · 24,3 % de 1 núcleo | 1º de 11 |
| 8 | [Tempo de atualização](#8-tempo-de-atualizacao) | Tauri · 28,5 ms (mediana) | Tarve · Bun · 66,1 ms (mediana) | 5º de 11 |

**Leitura rápida:** o Tarve é o mais rápido para abrir (métricas 2 e 3), usa a menor RAM com a tela vazia (4) e gasta a menor CPU na rolagem com desenho na GPU (7). Perde no tempo de atualização da lista (8): leva 66 ms com Bun ou Node, contra 28,5 ms no Tauri e no Electron, e 271 ms com txiki. Também perde em disco quando usa Bun ou Node (1).

## Tamanho e inicialização

### 1. Tamanho em disco

O que precisa ser distribuído (executável e arquivos ao lado). A coluna "Compactado" é o tamanho do download em .zip. O Tauri depende do WebView2 já instalado no Windows, que não entra na conta.

| # | App | MB | Em relação ao 1º | Compactado MB |
| ---: | --- | ---: | ---: | ---: |
| 1 | egui | 3,5 | — | 1,8 |
| 2 | Tauri | 4,1 | 1,2× | 1,6 |
| 3 | **Tarve · txiki** | 11,5 | 3,3× | 8,6 |
| 4 | **Tarve · txiki `lowPower`** | 11,5 | 3,3× | 8,6 |
| 5 | Dioxus Native | 14,9 | 4,3× | 6,4 |
| 6 | Flutter | 24,8 | 7,1× | 10,4 |
| 7 | **Tarve · Node** | 114,8 | 32,8× | 43,4 |
| 8 | **Tarve · Node `lowPower`** | 114,8 | 32,8× | 43,4 |
| 9 | **Tarve · Bun** | 150,7 | 43,1× | 75,9 |
| 10 | **Tarve · Bun `lowPower`** | 150,7 | 43,1× | 75,9 |
| 11 | Electron | 357,1 | 102,0× | 150,9 |

### 2. Primeiro quadro, tela vazia

Do `CreateProcess` até o conteúdo aparecer na tela.

| # | App | ms | Em relação ao 1º | Janela criada (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 124 | — | 47 |
| 2 | **Tarve · txiki** | 126 | 1,0× | 52 |
| 3 | **Tarve · Bun `lowPower`** | 131 | 1,1× | 54 |
| 4 | **Tarve · Bun** | 139 | 1,1× | 57 |
| 5 | egui | 277 | 2,2× | 166 |
| 6 | Electron | 378 | 3,0× | 120 |
| 7 | **Tarve · Node `lowPower`** | 427 | 3,4× | 356 |
| 8 | Tauri | 440 | 3,5× | 37 |
| 9 | **Tarve · Node** | 441 | 3,6× | 356 |
| 10 | Flutter | 547 | 4,4× | 471 |
| 11 | Dioxus Native | 966 | 7,8× | 238 |

### 3. Primeiro quadro, 2.000 linhas

O mesmo, com a lista inteira montada.

| # | App | ms | Em relação ao 1º | Janela criada (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Bun `lowPower`** | 212 | — | 132 |
| 2 | **Tarve · Bun** | 239 | 1,1× | 160 |
| 3 | egui | 298 | 1,4× | 175 |
| 4 | Electron | 367 | 1,7× | 113 |
| 5 | Tauri | 460 | 2,2× | 36 |
| 6 | **Tarve · txiki `lowPower`** | 486 | 2,3× | 406 |
| 7 | **Tarve · Node `lowPower`** | 509 | 2,4× | 435 |
| 8 | **Tarve · txiki** | 524 | 2,5× | 448 |
| 9 | **Tarve · Node** | 583 | 2,8× | 502 |
| 10 | Flutter | 743 | 3,5× | 668 |
| 11 | Dioxus Native | 957 | 4,5× | 232 |

## Memória

### 4. RAM ociosa, tela vazia

RAM física exclusiva do app (*private working set*), somando todos os seus processos. A coluna "Reservada" é a memória comprometida (*commit*).

| # | App | MB | Em relação ao 1º | Reservada (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 18,5 | — | 68,8 |
| 2 | **Tarve · txiki** | 24,4 | 1,3× | 129 |
| 3 | **Tarve · Bun `lowPower`** | 25,2 | 1,4× | 128,8 |
| 4 | **Tarve · Bun** | 32,5 | 1,8× | 319,5 |
| 5 | egui | 33,6 | 1,8× | 68,4 |
| 6 | Flutter | 50,8 | 2,7× | 163,9 |
| 7 | **Tarve · Node `lowPower`** | 59,7 | 3,2× | 73,4 |
| 8 | **Tarve · Node** | 65,9 | 3,6× | 133,9 |
| 9 | Electron | 72,7 | 3,9× | 147,2 |
| 10 | Tauri | 75,6 | 4,1× | 154,3 |
| 11 | Dioxus Native | 135,7 | 7,3× | 464,7 |

### 5. RAM ociosa, 2.000 linhas

O mesmo, com a lista montada.

| # | App | MB | Em relação ao 1º | Reservada (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | egui | 65,9 | — | 100,7 |
| 2 | **Tarve · txiki `lowPower`** | 87,9 | 1,3× | 146 |
| 3 | **Tarve · Bun `lowPower`** | 88,6 | 1,3× | 211,9 |
| 4 | **Tarve · txiki** | 96,4 | 1,5× | 215,2 |
| 5 | **Tarve · Bun** | 97,3 | 1,5× | 405,3 |
| 6 | **Tarve · Node `lowPower`** | 102,8 | 1,6× | 119,7 |
| 7 | Electron | 105,3 | 1,6× | 186,7 |
| 8 | **Tarve · Node** | 110,5 | 1,7× | 181,9 |
| 9 | Tauri | 115,7 | 1,8× | 200,4 |
| 10 | Dioxus Native | 172,1 | 2,6× | 507,8 |
| 11 | Flutter | 246,7 | 3,7× | 359,5 |

### 6. Memória de GPU

Memória de vídeo dedicada, segundo o contador `GPU Process Memory` do Windows. As variantes `lowPower` desenham na CPU e não usam a GPU.

| # | App | MB | Em relação ao 1º | Com 2.000 linhas (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Bun `lowPower`** | 0 | — | 0 |
| 2 | **Tarve · Node `lowPower`** | 0 | — | 0 |
| 3 | **Tarve · txiki `lowPower`** | 0 | — | 0 |
| 4 | egui | 22,8 | +22,8 | 22,8 |
| 5 | Tauri | 25,5 | +25,5 | 29,3 |
| 6 | Electron | 26,6 | +26,6 | 30,6 |
| 7 | **Tarve · Bun** | 33,4 | +33,4 | 33,4 |
| 8 | **Tarve · Node** | 33,4 | +33,4 | 33,4 |
| 9 | **Tarve · txiki** | 33,4 | +33,4 | 33,4 |
| 10 | Flutter | 68,8 | +68,8 | 68,8 |
| 11 | Dioxus Native | 269,2 | +269,2 | 269,2 |

## Interação

### 7. CPU durante a rolagem

240 giros reais da roda do mouse (via SendInput), a cerca de 60 por segundo, sobre a lista.

| # | App | % de 1 núcleo | Em relação ao 1º | Uso da GPU 3D % |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki** | 24,3 | — | 2,6 |
| 2 | **Tarve · Node** | 26,2 | 1,1× | 2,7 |
| 3 | **Tarve · Bun** | 30,5 | 1,3× | 2,8 |
| 4 | Tauri | 36,9 | 1,5× | 3,1 |
| 5 | Electron | 41,2 | 1,7× | 3,1 |
| 6 | Dioxus Native | 100,1 | 4,1× | 1,3 |
| 7 | egui | 102,8 | 4,2× | 0,8 |
| 8 | Flutter | 103,8 | 4,3× | 0,6 |
| 9 | **Tarve · Bun `lowPower`** | 120,4 | 5,0× | 0 |
| 10 | **Tarve · Node `lowPower`** | 121,3 | 5,0× | 0 |
| 11 | **Tarve · txiki `lowPower`** | 122 | 5,0× | 0 |

### 8. Tempo de atualização

30 cliques reais no botão "Update", cada um trocando o texto das 2.000 linhas. O tempo vai do clique até a nova cor aparecer na tela. Nenhum app teve falhas.

| # | App | ms (mediana) | Em relação ao 1º | Percentil 95 (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | Tauri | 28,5 | — | 32,8 |
| 2 | Electron | 28,6 | 1,0× | 33,7 |
| 3 | egui | 37,1 | 1,3× | 40,8 |
| 4 | Dioxus Native | 53,6 | 1,9× | 58,9 |
| 5 | **Tarve · Bun** | 66,1 | 2,3× | 74,7 |
| 6 | **Tarve · Bun `lowPower`** | 66,2 | 2,3× | 83,3 |
| 7 | **Tarve · Node** | 66,2 | 2,3× | 79 |
| 8 | **Tarve · Node `lowPower`** | 66,5 | 2,3× | 95,4 |
| 9 | Flutter | 158,3 | 5,6× | 186,8 |
| 10 | **Tarve · txiki** | 270,9 | 9,5× | 316,3 |
| 11 | **Tarve · txiki `lowPower`** | 274,5 | 9,6× | 321,7 |

## Onde o Tarve gasta a atualização das 2.000 linhas

Medido dentro do app com `app.stats()` (variável `STATS=1`), mediana:

| Fase | Bun | txiki |
| --- | ---: | ---: |
| Atualização no JS (montagem + comparação + envio) | 21,4 ms | 254,0 ms |
| ↳ montagem da árvore no JS | 13,5 ms | 208,3 ms |
| ↳ comparação com a árvore anterior no JS | 2,8 ms | 34,4 ms |
| aplicação das mudanças no nativo | 5,2 ms | 5,2 ms |
| cálculo de layout no nativo (taffy + texto) | 20,5 ms | 20,1 ms |
| desenho no nativo | 1,7 ms | 1,7 ms |

Com Bun, o tempo se divide entre o JS (cerca de 21 ms) e o layout nativo (cerca de 20 ms). No txiki, quem domina é a montagem da árvore em JS no QuickJS.

## Como foi medido

O medidor fica em `harness/`, é igual para todos os apps e só roda no Windows.

- **Tela:** um marcador de 48×48 no canto superior esquerdo, um botão "Update" e, na cena de lista, 2.000 linhas (texto e botão) com barra de rolagem. Cada clique em "Update" troca o texto de **todas** as linhas e a cor do marcador.
- **Primeiro quadro:** o marcador magenta é lido da imagem final da tela (BitBlt).
- **Memória e CPU:** somadas em toda a árvore de processos, porque Electron e WebView2 criam processos filhos. O app fica ocioso 3 s depois do primeiro quadro e então a CPU ociosa é medida por mais 5 s.
- **Entrada:** mouse real via SendInput, com a janela verificada no topo antes de cada clique.
- **Ordem:** as execuções são intercaladas por rodada, para que qualquer variação lenta da máquina afete todos os apps por igual.

Para reproduzir:

```
bun bench/frameworks/build.ts          # FLUTTER=<flutter.bat> se não estiver no PATH
RUNS=5 bun bench/frameworks/run.ts     # → work/frameworks/results.json, results.jsonl, shots/
```

## Limitações

- Uma única máquina, sempre com inicialização a quente (arquivos já no cache do sistema). Outras tarefas ocupavam 5–14% da CPU total, registrado na coluna "Máquina ocupada %".
- Nenhum app virtualiza a lista: Electron e Tauri usam React 19 sem virtualização e o Flutter usa `Column`. Com o `ListView.builder`, que seria o idiomático, o Flutter só criaria as linhas visíveis. O egui funciona em modo imediato e redesenha a tela inteira a cada entrada.
- O tempo inclui a sincronização com o monitor (vsync) e a composição de janelas do Windows (DWM), cerca de 4 ms a 240 Hz. Na tela vazia, todos ficam entre 4 e 12 ms.
- O Dioxus Native 0.7.10 ainda se declara experimental.

## Dados completos

Todas as métricas coletadas, em mediana de 5 execuções. As execuções individuais estão em `results/results.jsonl`, as medianas em `results/results.json` e as capturas da primeira execução em `results/shots/`. "Falhas" conta os cliques cuja mudança não apareceu na tela em até 3 s.

### Tela vazia

| App | Disco MB | Compactado MB | 1ª janela ms | 1º quadro ms | Reservada MB | RAM exclusiva MB | RAM total MB | Threads | Identificadores (handles) | Processos | CPU ociosa % | GPU dedicada MB | GPU compartilhada MB | CPU rolagem % | GPU 3D rolagem % | Atualização mediana ms | Atualização percentil 95 ms | Atualização máx ms | Falhas | Pico reservada MB | Pico RAM total MB | Reservada final MB | RAM exclusiva final MB | Máquina ocupada % | Execuções |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 150,7 | 75,9 | 57 | 139 | 319,5 | 32,5 | 82,8 | 90 | 644 | 1 | 0 | 33,4 | 2,3 | — | — | 8 | 12,7 | 20,8 | 0 | 338,8 | 89,2 | 338,8 | 36,1 | 5,4 | 5 |
| Tarve · Bun `lowPower` | 150,7 | 75,9 | 54 | 131 | 128,8 | 25,2 | 55,5 | 24 | 283 | 1 | 0 | 0 | 0 | — | — | 7,9 | 8,9 | 21 | 0 | 146,3 | 61,2 | 146 | 28,1 | 6,6 | 5 |
| Tarve · Node | 114,8 | 43,4 | 356 | 441 | 133,9 | 65,9 | 138,5 | 84 | 638 | 1 | 0 | 33,4 | 2,3 | — | — | 8,2 | 13 | 20,9 | 0 | 140,6 | 145 | 107,5 | 40,2 | 5,9 | 5 |
| Tarve · Node `lowPower` | 114,8 | 43,4 | 356 | 427 | 73,4 | 59,7 | 112,3 | 18 | 295 | 1 | 0 | 0 | 0 | — | — | 7,8 | 8,8 | 20,9 | 0 | 75 | 115 | 46,5 | 33,1 | 9,7 | 5 |
| Tarve · txiki | 11,5 | 8,6 | 52 | 126 | 129 | 24,4 | 65,7 | 84 | 639 | 1 | 0 | 33,4 | 2,3 | — | — | 7,8 | 12,6 | 20,9 | 0 | 135,7 | 72,4 | 129,6 | 25,6 | 13,9 | 5 |
| Tarve · txiki `lowPower` | 11,5 | 8,6 | 47 | 124 | 68,8 | 18,5 | 39,8 | 18 | 294 | 1 | 0 | 0 | 0 | — | — | 7,9 | 8,5 | 20,9 | 0 | 69,1 | 41,3 | 69,1 | 18,9 | 6,2 | 5 |
| Electron | 357,1 | 150,9 | 120 | 378 | 147,2 | 72,7 | 300,2 | 165 | 2351 | 4 | 0 | 26,6 | 1,9 | — | — | 8,1 | 12,5 | 12,9 | 0 | 151,5 | 303,5 | 151,5 | 74,4 | 6,1 | 5 |
| Tauri | 4,1 | 1,6 | 37 | 440 | 154,3 | 75,6 | 357,6 | 239 | 3536 | 7 | 0,6 | 25,5 | 2 | — | — | 12 | 13,1 | 13,6 | 0 | 160 | 364,7 | 157,3 | 77,4 | 6,8 | 5 |
| Flutter | 24,8 | 10,4 | 471 | 547 | 163,9 | 50,8 | 98,9 | 105 | 722 | 1 | 0 | 68,8 | 8 | — | — | 4,2 | 8,5 | 12,6 | 0 | 173,5 | 107,3 | 171,9 | 58,7 | 8,9 | 5 |
| Dioxus Native | 14,9 | 6,4 | 238 | 966 | 464,7 | 135,7 | 201,9 | 56 | 706 | 1 | 0,6 | 269,2 | 52,6 | — | — | 7,8 | 8,4 | 8,5 | 0 | 473 | 205,9 | 465,6 | 139,6 | 13,6 | 5 |
| egui | 3,5 | 1,8 | 166 | 277 | 68,4 | 33,6 | 65,2 | 16 | 389 | 1 | 0 | 22,8 | 5,7 | — | — | 4,8 | 8,5 | 9,1 | 0 | 73,4 | 70,9 | 73,4 | 39,2 | 5,4 | 5 |

### 2.000 linhas

| App | Disco MB | Compactado MB | 1ª janela ms | 1º quadro ms | Reservada MB | RAM exclusiva MB | RAM total MB | Threads | Handles | Processos | CPU ociosa % | GPU dedicada MB | GPU compartilhada MB | CPU rolagem % | GPU 3D rolagem % | Atualização mediana ms | Atualização p95 ms | Atualização máx ms | Falhas | Pico reservada MB | Pico RAM total MB | Reservada final MB | RAM exclusiva final MB | Máquina ocupada % | Execuções |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 150,7 | 75,9 | 160 | 239 | 405,3 | 97,3 | 153,8 | 90 | 645 | 1 | 0,3 | 33,4 | 3 | 30,5 | 2,8 | 66,1 | 74,7 | 82,5 | 0 | 542,9 | 251 | 501,8 | 151,7 | 6,7 | 5 |
| Tarve · Bun `lowPower` | 150,7 | 75,9 | 132 | 212 | 211,9 | 88,6 | 125 | 24 | 290 | 1 | 0 | 0 | 0 | 120,4 | 0 | 66,2 | 83,3 | 91 | 0 | 358,6 | 214,8 | 332,9 | 148,7 | 13 | 5 |
| Tarve · Node | 114,8 | 43,4 | 502 | 583 | 181,9 | 110,5 | 188,1 | 84 | 653 | 1 | 0 | 33,4 | 3 | 26,2 | 2,7 | 66,2 | 79 | 90,9 | 0 | 296,2 | 297,1 | 293 | 215 | 6,1 | 5 |
| Tarve · Node `lowPower` | 114,8 | 43,4 | 435 | 509 | 119,7 | 102,8 | 160,2 | 18 | 302 | 1 | 0 | 0 | 0 | 121,3 | 0 | 66,5 | 95,4 | 104,5 | 0 | 242,4 | 277,7 | 240,9 | 217 | 5,2 | 5 |
| Tarve · txiki | 11,5 | 8,6 | 448 | 524 | 215,2 | 96,4 | 137,8 | 83 | 662 | 1 | 0 | 33,4 | 3,3 | 24,3 | 2,6 | 270,9 | 316,3 | 354,1 | 0 | 254,4 | 176,8 | 229,1 | 111,8 | 8,7 | 5 |
| Tarve · txiki `lowPower` | 11,5 | 8,6 | 406 | 486 | 146 | 87,9 | 110,1 | 18 | 301 | 1 | 0 | 0 | 0 | 122 | 0 | 274,5 | 321,7 | 358,2 | 0 | 205,4 | 161,9 | 198,2 | 132,7 | 9,2 | 5 |
| Electron | 357,1 | 150,9 | 113 | 367 | 186,7 | 105,3 | 336,3 | 169 | 2369 | 4 | 0,3 | 30,6 | 2,1 | 41,2 | 3,1 | 28,6 | 33,7 | 37,6 | 0 | 257 | 404,8 | 255,8 | 168,2 | 9,2 | 5 |
| Tauri | 4,1 | 1,6 | 36 | 460 | 200,4 | 115,7 | 402,8 | 239 | 3547 | 7 | 0 | 29,3 | 2,2 | 36,9 | 3,1 | 28,5 | 32,8 | 37,2 | 0 | 268,3 | 472,9 | 264,6 | 175,5 | 6 | 5 |
| Flutter | 24,8 | 10,4 | 668 | 743 | 359,5 | 246,7 | 295 | 106 | 728 | 1 | 0,3 | 68,8 | 8 | 103,8 | 0,6 | 158,3 | 186,8 | 203,7 | 0 | 434,4 | 365,1 | 403,9 | 287,1 | 10,9 | 5 |
| Dioxus Native | 14,9 | 6,4 | 232 | 957 | 507,8 | 172,1 | 238,4 | 56 | 706 | 1 | 0 | 269,2 | 52,6 | 100,1 | 1,3 | 53,6 | 58,9 | 65,9 | 0 | 519,9 | 244,1 | 509,9 | 177,2 | 13,5 | 5 |
| egui | 3,5 | 1,8 | 175 | 298 | 100,7 | 65,9 | 97,5 | 16 | 389 | 1 | 0 | 22,8 | 6,7 | 102,8 | 0,8 | 37,1 | 40,8 | 41,8 | 0 | 144,8 | 136,9 | 141,7 | 103 | 6,3 | 5 |
