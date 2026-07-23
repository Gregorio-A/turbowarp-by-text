# TextWarp 0.3

Editor textual por ator sobre o TurboWarp Desktop. O Monaco é a fonte principal e permanece sincronizado com o workspace Blockly e com a `scratch-vm` real.

O projeto mantém somente a infraestrutura local necessária para editar, executar, depurar e empacotar projetos TextWarp:

- Electron e a interface `scratch-gui`;
- palco, atores, fantasias, sons, monitores e extensões;
- Monaco, Blockly e compilação incremental TextWarp;
- importação e exportação `.textwarp` e `.sb3`;
- breakpoints, pausa de threads e passo a passo;
- biblioteca, extensões offline, Addons e Packager usados pelo aplicativo;
- empacotamento local com Electron Builder.

A sintaxe e a arquitetura estão em [TEXTWARP.md](TEXTWARP.md), e o uso de cada bloco está na referência gerada
[TEXTWARP_BLOCOS.md](TEXTWARP_BLOCOS.md). Problemas abertos e prioridades estão em
[TEXTWARP_PRIORIDADES.md](TEXTWARP_PRIORIDADES.md).
O ambiente completo de edição, navegação, execução e depuração está descrito em
[TEXTWARP_IDE.md](TEXTWARP_IDE.md).

## Estrutura necessária

```text
src-main/              processo principal do Electron
src-preload/           ponte segura entre Electron e renderizadores
src-renderer/          páginas auxiliares usadas pelo aplicativo
src-renderer-webpack/  interface do editor e implementação TextWarp
scripts/               download de recursos e geração da referência de blocos
build/                 ícones e configuração do empacotamento local
linux-files/           integração dos pacotes Linux
test/textwarp/         testes do compilador, VM, pacote e sincronização
```

`dist-renderer-webpack`, `dist-library-files` e `dist-extensions` são artefatos gerados ou baixados. `node_modules` contém as dependências completas de `scratch-gui`, `scratch-vm`, Electron e Webpack; esses diretórios não fazem parte da fonte rastreada pelo Git.

## Preparação

```bash
npm ci --include=dev
npm run fetch
```

O `fetch` baixa a biblioteca de recursos, o Packager e as extensões offline. A configuração `.npmrc` permite instalar as dependências Git fixadas pelo TurboWarp.

## Desenvolvimento

Compile a interface e inicie o Electron:

```bash
npm run webpack:compile
npm run electron:start
```

Durante o desenvolvimento da interface, também é possível deixar o Webpack observando alterações:

```bash
npm run webpack:watch
```

## Validação

```bash
npm run test:textwarp
npm run docs:textwarp:check
npm run webpack:compile
git diff --check
```

## Empacotamento local

Para gerar uma pasta executável sem os pipelines de publicação do TurboWarp:

```bash
npm run webpack:prod
npm run electron:package:dir
```

O projeto é distribuído sob GPLv3. Consulte [LICENSE](LICENSE).
