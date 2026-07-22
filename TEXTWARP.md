# TextWarp 0.3

TextWarp é uma linguagem textual por ator sobre o runtime do TurboWarp. O Monaco Editor é a fonte principal, mas o workspace Blockly continua disponível em modo editável e sincronizado. Palco, atores, fantasias, sons, monitores, extensões e Packager continuam sendo os componentes do TurboWarp Desktop.

O compilador gera blocos Scratch reais. Dessa forma, concorrência, esperas, transmissões, clones, coerções e procedimentos continuam sendo executados pela `scratch-vm`, em vez de uma tradução direta e incompatível para JavaScript.

## Instalar e executar

Use Node.js 22 quando possível. A versão 26 também foi usada durante o desenvolvimento desta árvore, mas não é a versão recomendada pelo upstream.

```bash
npm ci --include=dev
npm run fetch
npm run webpack:compile
npm run electron:start
```

O `.npmrc` local permite dependências Git, necessárias para os pacotes do TurboWarp. Os avisos de pacotes antigos durante `npm ci` vêm da árvore upstream; o erro que impede a instalação é aquele que termina com `npm error`, não os avisos `deprecated`.

Durante o desenvolvimento, deixe estes comandos em terminais separados:

```bash
npm run webpack:watch
```

```bash
npm run electron:start
```

Validação automatizada:

```bash
npm run test:textwarp
npm run webpack:compile
```

## Fluxo no editor

1. Selecione o palco ou um ator.
2. Edite `stage.tw` ou o arquivo virtual do ator.
3. Aguarde o debounce de 300 ms ou clique em **Compilar**.
4. Clique em **Executar** ou use a bandeira verde normal.
5. Use **Blocos** para editar visualmente ou **Dividido** para manter texto e blocos lado a lado.
6. Clique na margem de uma linha para criar um breakpoint e abra **Depurar** para acompanhar todas as threads.

Alterações válidas no texto são compiladas para o workspace. Alterações no Blockly são decompiladas de volta para a forma textual canônica. Se os dois lados forem alterados antes da sincronização, uma faixa de conflito permite escolher **Manter texto** ou **Usar blocos**.

O botão **Importar blocos** também faz uma conversão explícita do alvo. Opcodes sem conversor específico usam `raw.command`, `raw.reporter`, `raw.hat` ou `raw.stack`, preservando campos, mutation e entradas em vez de abandonar o stack.

`Ctrl+S` salva no arquivo `.textwarp` aberto e `Ctrl+Shift+S` escolhe outro arquivo. **Salvar como…** faz a mesma exportação editável; **Abrir .textwarp** abre o pacote. O fluxo padrão do TurboWarp continua disponível para gerar `.sb3` como artefato compilado.

## Sintaxe

A indentação usa exatamente quatro espaços. Comentários começam com `#`.

### Variáveis, listas e expressões

```text
actor Player

variable speed = 5
variable health = 100
list hits = []

on green_flag:
    health = 100
    speed += 2
    list_add(hits, health)

    if health > 0 and not key_pressed("space"):
        change_x(speed * 2)
    else:
        say(join("vida: ", health))
```

O palco declara dados globais:

```text
stage

global variable score = 0
global list enemies = ["Enemy", "Boss"]
```

Variáveis e listas globais declaradas no palco podem ser lidas e alteradas diretamente pelos atores. Ao importar blocos de um ator, o decompilador consulta o palco para preservar essas referências sem criar declarações locais duplicadas.

Inicializadores precisam ser constantes. Variáveis aceitam número ou string; listas aceitam uma lista literal de números e strings.

Operadores disponíveis:

```text
+  -  *  /  %
<  <=  ==  !=  >=  >
and  or  not
```

Atribuições disponíveis:

```text
score = 0
score += 1
score -= damage
```

Funções de lista:

```text
list_add(items, value)
list_delete(items, index)
list_clear(items)
list_insert(items, index, value)
list_replace(items, index, value)

list_item(items, index)
list_index(items, value)
list_length(items)
list_contains(items, value)
```

### Condições e laços

```text
if touching("Enemy"):
    say("atingido")
else:
    move(10)

repeat(10):
    move(2)

repeat_until(touching("_edge_")):
    move(2)

while health > 0:
    wait(0)

forever:
    wait(0)
```

`while condition` é compilado como o bloco Scratch `repeat until not condition`.

### Procedimentos e parâmetros

```text
procedure take_damage(amount):
    health -= amount

    if health <= 0:
        broadcast("player-died")
        delete_clone()

on green_flag:
    take_damage(10)
```

Parâmetros podem ser `any`, `number`, `string` ou `boolean`. Os três primeiros usam o encaixe `%s` da VM; booleanos usam `%b` e o bloco hexagonal correto.

```text
procedure twice(value: number) -> number warp:
    return value * 2

procedure can_move(enabled: boolean) -> boolean:
    if enabled:
        return not touching("_edge_")
    return false

on green_flag:
    if can_move(true):
        change_x(twice(3))
```

`-> number`, `-> string` e `-> any` criam uma chamada repórter redonda; `-> boolean` cria uma chamada booleana. `return` gera `procedures_return`. O modificador `warp` ativa o modo sem atualização de tela do procedimento. Procedimentos são locais ao ator e podem ser chamados antes ou depois da declaração textual.

### Eventos, transmissões e clones

```text
on green_flag:
    broadcast("start-game")

on clicked:
    broadcast_wait("clicked")

on key_pressed("space"):
    create_clone("_myself_")

on receive("start-game"):
    show()

on backdrop_switches("level-2"):
    say("fase 2")

on loudness_greater_than(10):
    hide()

on timer_greater_than(5):
    say("tempo")

on clone_started:
    forever:
        change_y(-8)
        if touching("_edge_"):
            delete_clone()
```

`clone_started` só é válido em atores. O evento `clicked` escolhe automaticamente `event_whenstageclicked` ou `event_whenthisspriteclicked` conforme o alvo.

### Comandos e repórteres principais

Movimento:

```text
move(steps)
turn_right(degrees)
turn_left(degrees)
point_in_direction(direction)
point_towards(target)
go_to(x, y)
go_to_target(target)
glide_to(seconds, x, y)
glide_to_target(seconds, target)
change_x(amount)
set_x(value)
change_y(amount)
set_y(value)
if_on_edge_bounce()
set_rotation_style(style)
x_position()
y_position()
direction()
```

Os alvos especiais dos menus são `"_mouse_"` e `"_random_"`. Os estilos de rotação aceitos são `"all around"`, `"left-right"` e `"don't rotate"`.

Aparência e controle:

```text
say(message)
say_for(message, seconds)
think(message)
show()
hide()
wait(seconds)
stop_all()
```

Sensores e operadores:

```text
key_pressed(key)
touching(object)
mouse_down()
timer()
answer()
random(from, to)
round(value)
join(left, right)
letter(index, text)
length(text)
contains(text, part)
```

## Extensões

O catálogo é reconstruído automaticamente dos metadados que a VM obteve por `getInfo()`. O identificador canônico não depende do texto traduzido:

```text
extensionId.opcode
```

Exemplo com uma extensão carregada:

```text
on green_flag:
    physics.setGravity(9.8)

    if physics.isGrounded():
        say("no chão")
```

Comandos, repórteres, booleanos, hats e eventos entram no autocomplete do Monaco. Argumentos e menus usam os nomes internos publicados pela extensão. Condicionais e loops usam `:` para o primeiro braço e `branch N:` para os demais:

```text
on green_flag:
    flow.choose(2):
        say("primeiro braço")
    branch 2:
        say("segundo braço")
    branch 3:
        say("terceiro braço")
```

O painel **Extensões** lista também botões, labels, separadores e XML publicados por `getInfo()`. Botões próprios da extensão podem ser acionados no painel. Esses itens de paleta não viram comandos fictícios na linguagem, pois não são primitivas executáveis; os blocos inseridos por XML são decompilados normalmente ou pelo fallback `raw.*`.

O TextWarp não muda o modelo de segurança: extensões sandboxed continuam isoladas e extensões unsandboxed continuam executando com privilégios elevados.

## Formato `.textwarp`

`.textwarp` é um ZIP editável e versionável separado do artefato Scratch. Sua estrutura é:

```text
project.textwarp
├── manifest.json
├── sources/
│   ├── stage-<moduleId>.tw
│   └── player-<moduleId>.tw
├── project/
│   └── project.json
├── assets/
├── extensions/
│   └── lock.json
└── compiled/
    └── project.sb3
```

As fontes em `sources/` são canônicas. Ao abrir o pacote, cada módulo é compilado novamente; se uma fonte tiver erro, o SB3 compilado permanece carregado e os diagnósticos são informados. `compiled/project.sb3` permite execução e compatibilidade com as ferramentas existentes, enquanto `project/` e `assets/` deixam os recursos explícitos no pacote.

O handle de `.textwarp` é mantido separado do handle de `.sb3`, evitando sobrescrever um formato com o outro. `Ctrl+S` grava o pacote editável atual; `Ctrl+Shift+S` e **Salvar como…** escolhem outro destino. A exportação padrão do TurboWarp continua produzindo `.sb3`.

## Importação de blocos

O decompilador reconhece os eventos, controles, dados, procedimentos com retorno, expressões e extensões presentes no catálogo da versão atual. Ele:

- cria declarações para variáveis e listas do alvo;
- reconstrói procedimentos e parâmetros;
- gera fonte com quatro espaços;
- produz um source map novo;
- representa condicionais de extensão com qualquer `branchCount`;
- encapsula qualquer opcode restante em JSON textual `raw.*`, mantendo campos, mutation, shadows e entradas;
- adota todos os stacks que puder reconstruir sem perda estrutural.

Nomes Scratch que não são identificadores válidos são normalizados. O fallback `raw.*` é deliberadamente verboso e serve como escape hatch de compatibilidade, não como sintaxe recomendada para código escrito à mão.

## Edição visual sincronizada

As abas **Blocos** e **Dividido** montam o workspace oficial de `scratch-gui`, ligado ao mesmo `vm.blockListener` usado pelo TurboWarp. Não existe uma segunda cópia do grafo: texto e Blockly alteram os blocos reais do alvo.

O sincronizador compara a estrutura do alvo, ignora mudanças causadas pela própria compilação e decompila alterações visuais após debounce. Ao aceitar a versão visual, os hashes e IDs das unidades são adotados por linha de origem, de modo que a próxima alteração textual ainda possa preservar eventos e procedimentos não afetados.

## Depurador concorrente

Clique na margem do Monaco para alternar um breakpoint. O painel **Depurar** mostra cada thread com ator, linha e estado, e oferece:

- pausar todas no próximo bloco mapeado;
- continuar todas;
- continuar uma thread;
- executar um passo de uma thread;
- destacar simultaneamente todas as linhas ativas;
- relacionar erros de primitivas com o source map.

Abrir o painel apenas para observar threads mantém o JIT ligado e usa snapshots periódicos da VM. O interpretador é ativado somente quando existe breakpoint, pedido de pausa ou execução passo a passo, pois essas operações precisam interceptar primitivas bloco a bloco. Assim que nenhuma pausa for necessária, a configuração anterior do compilador é restaurada.

## Compilação incremental

Cada evento e procedimento é uma unidade com identidade e hash próprios. Em uma recompilação:

1. unidades com o mesmo hash e os mesmos IDs permanecem na VM;
2. somente unidades alteradas são removidas e recriadas;
3. unidades removidas têm apenas seus stacks gerados apagados;
4. threads que estão executando blocos substituídos são encerradas;
5. stacks manuais e unidades não afetadas continuam intactos.

Após um `.sb3` otimizar IDs, o adaptador alinha cada unidade pela ordem estrutural e pelos opcodes, remapeia o source map e continua preservando unidades não alteradas mesmo com os novos identificadores.

## Arquitetura

```text
Fonte .tw
    ↓
Lexer de expressões + parser por indentação
    ↓
AST independente da VM
    ↓
Análise semântica + catálogo de blocos/extensões
    ↓
TextWarp IR por unidade
    ↓
Grafo Scratch + source map
    ↓
Adaptador incremental
    ↓
scratch-vm
```

Módulos principais em `src-renderer-webpack/editor/text/`:

- `parser.js`: linhas, indentação e parser de expressões;
- `block-registry.js`: catálogo canônico dos blocos principais;
- `extension-catalog.js`: adaptação automática de `getInfo()`;
- `compiler.js`: semântica, IR, unidades, hashes, source map e grafo;
- `vm-adapter.js`: atualização incremental, dados e persistência;
- `decompiler.js`: blocos existentes para texto;
- `textwarp-package.js`: importação/exportação `.textwarp`;
- `debug-controller.js`: breakpoints e threads concorrentes;
- `text-editor.jsx`: integração da interface;
- `textwarp-session.js`: handle separado e salvamento seguro de `.textwarp`;
- `monaco-loader.js`: realce, snippets e autocomplete.

O Webpack substitui apenas `scratch-gui/src/containers/blocks.jsx`; os pacotes dentro de `node_modules` não são editados diretamente.

## Persistência no `.sb3`

Fonte, breakpoints, source map, hashes e unidades ficam em comentários internos minimizados. Marcadores ligados às raízes sobrevivem à compactação de IDs feita pelo serializador. Se o texto ficar inválido, ele é salvo, mas a última versão compilada continua executável.

Variáveis e listas declaradas recebem IDs determinísticos. Blocos manuais não marcados como gerados não são removidos pelo adaptador.

## Limites atuais

- parâmetros `number`, `string` e `any` compartilham `%s`; um `.sb3` sem a fonte TextWarp não permite reconstruir essa distinção;
- aceitar alterações dos blocos normaliza comentários, espaçamento e ordem textual para a saída canônica do decompilador;
- `raw.*` preserva opcodes de terceiros, mas eles só executam se a extensão ou primitiva correspondente estiver carregada;
- itens de paleta `label`, `button` e XML aparecem no catálogo, mas não são instruções executáveis da linguagem;
- edição realmente simultânea pode gerar conflito; o editor exige escolher texto ou blocos em vez de mesclar duas alterações semanticamente;
- breakpoints, pausa e passo a passo ainda exigem o interpretador e reduzem desempenho enquanto estiverem ativos;
- procedimentos com retorno são um recurso do TurboWarp e não são compatíveis com o site oficial do Scratch.
