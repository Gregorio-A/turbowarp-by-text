'use strict';

const numberInput = (name, input, shadowOpcode = 'math_number', shadowField = 'NUM') => Object.freeze({
    name,
    role: 'input',
    valueType: 'number',
    input,
    shadowOpcode,
    shadowField
});

const textInput = (name, input) => Object.freeze({
    name,
    role: 'input',
    valueType: 'string',
    input,
    shadowOpcode: 'text',
    shadowField: 'TEXT'
});

const valueInput = (name, input) => Object.freeze({
    name,
    role: 'input',
    valueType: 'any',
    input,
    shadowOpcode: 'text',
    shadowField: 'TEXT'
});

const menuInput = (name, input, menuOpcode, menuField, defaultValue) => Object.freeze({
    name,
    role: 'menu',
    valueType: 'string',
    input,
    menuOpcode,
    menuField,
    defaultValue
});

const blockRegistry = Object.freeze({
    move: Object.freeze({
        opcode: 'motion_movesteps', kind: 'command', allowStage: false,
        arguments: [numberInput('steps', 'STEPS')],
        documentation: 'move(steps) — move o ator.'
    }),
    turn_right: Object.freeze({
        opcode: 'motion_turnright', kind: 'command', allowStage: false,
        arguments: [numberInput('degrees', 'DEGREES')],
        documentation: 'turn_right(degrees) — gira no sentido horário.'
    }),
    turn_left: Object.freeze({
        opcode: 'motion_turnleft', kind: 'command', allowStage: false,
        arguments: [numberInput('degrees', 'DEGREES')],
        documentation: 'turn_left(degrees) — gira no sentido anti-horário.'
    }),
    point_in_direction: Object.freeze({
        opcode: 'motion_pointindirection', kind: 'command', allowStage: false,
        arguments: [numberInput('direction', 'DIRECTION', 'math_angle')],
        documentation: 'point_in_direction(direction) — aponta o ator para uma direção.'
    }),
    point_towards: Object.freeze({
        opcode: 'motion_pointtowards', kind: 'command', allowStage: false,
        arguments: [menuInput('target', 'TOWARDS', 'motion_pointtowards_menu', 'TOWARDS', '_mouse_')],
        documentation: 'point_towards(target) — aponta para um ator, "_mouse_" ou "_random_".'
    }),
    go_to: Object.freeze({
        opcode: 'motion_gotoxy', kind: 'command', allowStage: false,
        arguments: [numberInput('x', 'X'), numberInput('y', 'Y')],
        documentation: 'go_to(x, y) — posiciona o ator.'
    }),
    go_to_target: Object.freeze({
        opcode: 'motion_goto', kind: 'command', allowStage: false,
        arguments: [menuInput('target', 'TO', 'motion_goto_menu', 'TO', '_random_')],
        documentation: 'go_to_target(target) — vai para um ator, "_mouse_" ou "_random_".'
    }),
    glide_to: Object.freeze({
        opcode: 'motion_glidesecstoxy', kind: 'command', allowStage: false,
        arguments: [
            numberInput('seconds', 'SECS'),
            numberInput('x', 'X'),
            numberInput('y', 'Y')
        ],
        documentation: 'glide_to(seconds, x, y) — desliza até uma posição.'
    }),
    glide_to_target: Object.freeze({
        opcode: 'motion_glideto', kind: 'command', allowStage: false,
        arguments: [
            numberInput('seconds', 'SECS'),
            menuInput('target', 'TO', 'motion_glideto_menu', 'TO', '_random_')
        ],
        documentation: 'glide_to_target(seconds, target) — desliza até um ator, "_mouse_" ou "_random_".'
    }),
    change_x: Object.freeze({
        opcode: 'motion_changexby', kind: 'command', allowStage: false,
        arguments: [numberInput('amount', 'DX')],
        documentation: 'change_x(amount) — altera x.'
    }),
    set_x: Object.freeze({
        opcode: 'motion_setx', kind: 'command', allowStage: false,
        arguments: [numberInput('value', 'X')],
        documentation: 'set_x(value) — define x.'
    }),
    change_y: Object.freeze({
        opcode: 'motion_changeyby', kind: 'command', allowStage: false,
        arguments: [numberInput('amount', 'DY')],
        documentation: 'change_y(amount) — altera y.'
    }),
    set_y: Object.freeze({
        opcode: 'motion_sety', kind: 'command', allowStage: false,
        arguments: [numberInput('value', 'Y')],
        documentation: 'set_y(value) — define y.'
    }),
    if_on_edge_bounce: Object.freeze({
        opcode: 'motion_ifonedgebounce', kind: 'command', allowStage: false, arguments: [],
        documentation: 'if_on_edge_bounce() — rebate o ator quando ele toca a borda.'
    }),
    set_rotation_style: Object.freeze({
        opcode: 'motion_setrotationstyle', kind: 'command', allowStage: false,
        arguments: [Object.freeze({
            name: 'style', role: 'field', valueType: 'string', field: 'STYLE', defaultValue: 'all around'
        })],
        documentation: 'set_rotation_style(style) — usa "all around", "left-right" ou "don\'t rotate".'
    }),
    wait: Object.freeze({
        opcode: 'control_wait', kind: 'command', allowStage: true,
        arguments: [numberInput('seconds', 'DURATION', 'math_positive_number')],
        documentation: 'wait(seconds) — pausa só esta thread.'
    }),
    say: Object.freeze({
        opcode: 'looks_say', kind: 'command', allowStage: false,
        arguments: [textInput('message', 'MESSAGE')],
        documentation: 'say(message) — mostra um balão de fala.'
    }),
    say_for: Object.freeze({
        opcode: 'looks_sayforsecs', kind: 'command', allowStage: false,
        arguments: [textInput('message', 'MESSAGE'), numberInput('seconds', 'SECS', 'math_positive_number')],
        documentation: 'say_for(message, seconds) — fala por um período.'
    }),
    think: Object.freeze({
        opcode: 'looks_think', kind: 'command', allowStage: false,
        arguments: [textInput('message', 'MESSAGE')],
        documentation: 'think(message) — mostra um balão de pensamento.'
    }),
    show: Object.freeze({
        opcode: 'looks_show', kind: 'command', allowStage: false, arguments: [],
        documentation: 'show() — mostra o ator.'
    }),
    hide: Object.freeze({
        opcode: 'looks_hide', kind: 'command', allowStage: false, arguments: [],
        documentation: 'hide() — esconde o ator.'
    }),
    broadcast: Object.freeze({
        opcode: 'event_broadcast', kind: 'command', allowStage: true,
        arguments: [Object.freeze({name: 'message', role: 'broadcast', input: 'BROADCAST_INPUT'})],
        documentation: 'broadcast(message) — envia uma transmissão.'
    }),
    broadcast_wait: Object.freeze({
        opcode: 'event_broadcastandwait', kind: 'command', allowStage: true,
        arguments: [Object.freeze({name: 'message', role: 'broadcast', input: 'BROADCAST_INPUT'})],
        documentation: 'broadcast_wait(message) — transmite e aguarda os receptores.'
    }),
    create_clone: Object.freeze({
        opcode: 'control_create_clone_of', kind: 'command', allowStage: false,
        arguments: [Object.freeze({
            name: 'actor', role: 'menu', valueType: 'string', input: 'CLONE_OPTION',
            menuOpcode: 'control_create_clone_of_menu', menuField: 'CLONE_OPTION', defaultValue: '_myself_'
        })],
        documentation: 'create_clone(actor) — cria um clone; use "_myself_" para o próprio ator.'
    }),
    delete_clone: Object.freeze({
        opcode: 'control_delete_this_clone', kind: 'command', allowStage: false, arguments: [], terminal: true,
        documentation: 'delete_clone() — remove o clone atual.'
    }),
    stop_all: Object.freeze({
        opcode: 'control_stop', kind: 'command', allowStage: true, arguments: [], terminal: true,
        staticFields: {STOP_OPTION: 'all'},
        mutation: {tagName: 'mutation', children: [], hasnext: 'false'},
        documentation: 'stop_all() — encerra todas as threads.'
    }),
    list_add: Object.freeze({
        opcode: 'data_addtolist', kind: 'command', allowStage: true,
        arguments: [Object.freeze({name: 'list', role: 'list', field: 'LIST'}), valueInput('value', 'ITEM')],
        documentation: 'list_add(list, value) — adiciona ao final da lista.'
    }),
    list_delete: Object.freeze({
        opcode: 'data_deleteoflist', kind: 'command', allowStage: true,
        arguments: [Object.freeze({name: 'list', role: 'list', field: 'LIST'}), numberInput('index', 'INDEX', 'math_integer')],
        documentation: 'list_delete(list, index) — remove um item.'
    }),
    list_clear: Object.freeze({
        opcode: 'data_deletealloflist', kind: 'command', allowStage: true,
        arguments: [Object.freeze({name: 'list', role: 'list', field: 'LIST'})],
        documentation: 'list_clear(list) — esvazia a lista.'
    }),
    list_insert: Object.freeze({
        opcode: 'data_insertatlist', kind: 'command', allowStage: true,
        arguments: [
            Object.freeze({name: 'list', role: 'list', field: 'LIST'}),
            numberInput('index', 'INDEX', 'math_integer'),
            valueInput('value', 'ITEM')
        ],
        documentation: 'list_insert(list, index, value) — insere um item.'
    }),
    list_replace: Object.freeze({
        opcode: 'data_replaceitemoflist', kind: 'command', allowStage: true,
        arguments: [
            Object.freeze({name: 'list', role: 'list', field: 'LIST'}),
            numberInput('index', 'INDEX', 'math_integer'),
            valueInput('value', 'ITEM')
        ],
        documentation: 'list_replace(list, index, value) — substitui um item.'
    }),

    x_position: Object.freeze({
        opcode: 'motion_xposition', kind: 'reporter', allowStage: false, arguments: [], documentation: 'x_position()'
    }),
    y_position: Object.freeze({
        opcode: 'motion_yposition', kind: 'reporter', allowStage: false, arguments: [], documentation: 'y_position()'
    }),
    direction: Object.freeze({
        opcode: 'motion_direction', kind: 'reporter', allowStage: false, arguments: [], documentation: 'direction()'
    }),
    key_pressed: Object.freeze({
        opcode: 'sensing_keypressed', kind: 'boolean', allowStage: true,
        arguments: [menuInput('key', 'KEY_OPTION', 'sensing_keyoptions', 'KEY_OPTION', 'space')],
        documentation: 'key_pressed(key) — informa se uma tecla está pressionada.'
    }),
    touching: Object.freeze({
        opcode: 'sensing_touchingobject', kind: 'boolean', allowStage: false,
        arguments: [menuInput('object', 'TOUCHINGOBJECTMENU', 'sensing_touchingobjectmenu', 'TOUCHINGOBJECTMENU', '_edge_')],
        documentation: 'touching(object) — testa contato com ator, mouse ou borda.'
    }),
    mouse_down: Object.freeze({
        opcode: 'sensing_mousedown', kind: 'boolean', allowStage: true, arguments: [], documentation: 'mouse_down()'
    }),
    timer: Object.freeze({
        opcode: 'sensing_timer', kind: 'reporter', allowStage: true, arguments: [], documentation: 'timer()'
    }),
    answer: Object.freeze({
        opcode: 'sensing_answer', kind: 'reporter', allowStage: true, arguments: [], documentation: 'answer()'
    }),
    random: Object.freeze({
        opcode: 'operator_random', kind: 'reporter', allowStage: true,
        arguments: [numberInput('from', 'FROM'), numberInput('to', 'TO')], documentation: 'random(from, to)'
    }),
    round: Object.freeze({
        opcode: 'operator_round', kind: 'reporter', allowStage: true,
        arguments: [numberInput('value', 'NUM')], documentation: 'round(value)'
    }),
    join: Object.freeze({
        opcode: 'operator_join', kind: 'reporter', allowStage: true,
        arguments: [valueInput('left', 'STRING1'), valueInput('right', 'STRING2')], documentation: 'join(left, right)'
    }),
    letter: Object.freeze({
        opcode: 'operator_letter_of', kind: 'reporter', allowStage: true,
        arguments: [numberInput('index', 'LETTER', 'math_whole_number'), valueInput('text', 'STRING')], documentation: 'letter(index, text)'
    }),
    length: Object.freeze({
        opcode: 'operator_length', kind: 'reporter', allowStage: true,
        arguments: [valueInput('text', 'STRING')], documentation: 'length(text)'
    }),
    contains: Object.freeze({
        opcode: 'operator_contains', kind: 'boolean', allowStage: true,
        arguments: [valueInput('text', 'STRING1'), valueInput('part', 'STRING2')], documentation: 'contains(text, part)'
    }),
    list_item: Object.freeze({
        opcode: 'data_itemoflist', kind: 'reporter', allowStage: true,
        arguments: [Object.freeze({name: 'list', role: 'list', field: 'LIST'}), numberInput('index', 'INDEX', 'math_integer')],
        documentation: 'list_item(list, index)'
    }),
    list_index: Object.freeze({
        opcode: 'data_itemnumoflist', kind: 'reporter', allowStage: true,
        arguments: [Object.freeze({name: 'list', role: 'list', field: 'LIST'}), valueInput('value', 'ITEM')],
        documentation: 'list_index(list, value)'
    }),
    list_length: Object.freeze({
        opcode: 'data_lengthoflist', kind: 'reporter', allowStage: true,
        arguments: [Object.freeze({name: 'list', role: 'list', field: 'LIST'})], documentation: 'list_length(list)'
    }),
    list_contains: Object.freeze({
        opcode: 'data_listcontainsitem', kind: 'boolean', allowStage: true,
        arguments: [Object.freeze({name: 'list', role: 'list', field: 'LIST'}), valueInput('value', 'ITEM')],
        documentation: 'list_contains(list, value)'
    })
});

const operatorRegistry = Object.freeze({
    '+': Object.freeze({opcode: 'operator_add', kind: 'reporter', arguments: [numberInput('left', 'NUM1'), numberInput('right', 'NUM2')]}),
    '-': Object.freeze({opcode: 'operator_subtract', kind: 'reporter', arguments: [numberInput('left', 'NUM1'), numberInput('right', 'NUM2')]}),
    '*': Object.freeze({opcode: 'operator_multiply', kind: 'reporter', arguments: [numberInput('left', 'NUM1'), numberInput('right', 'NUM2')]}),
    '/': Object.freeze({opcode: 'operator_divide', kind: 'reporter', arguments: [numberInput('left', 'NUM1'), numberInput('right', 'NUM2')]}),
    '%': Object.freeze({opcode: 'operator_mod', kind: 'reporter', arguments: [numberInput('left', 'NUM1'), numberInput('right', 'NUM2')]}),
    '<': Object.freeze({opcode: 'operator_lt', kind: 'boolean', arguments: [valueInput('left', 'OPERAND1'), valueInput('right', 'OPERAND2')]}),
    '==': Object.freeze({opcode: 'operator_equals', kind: 'boolean', arguments: [valueInput('left', 'OPERAND1'), valueInput('right', 'OPERAND2')]}),
    '>': Object.freeze({opcode: 'operator_gt', kind: 'boolean', arguments: [valueInput('left', 'OPERAND1'), valueInput('right', 'OPERAND2')]}),
    and: Object.freeze({opcode: 'operator_and', kind: 'boolean', arguments: [valueInput('left', 'OPERAND1'), valueInput('right', 'OPERAND2')]}),
    or: Object.freeze({opcode: 'operator_or', kind: 'boolean', arguments: [valueInput('left', 'OPERAND1'), valueInput('right', 'OPERAND2')]}),
    not: Object.freeze({opcode: 'operator_not', kind: 'boolean', arguments: [valueInput('value', 'OPERAND')]})
});

const controlRegistry = Object.freeze({
    repeat: Object.freeze({
        opcode: 'control_repeat', argumentInput: 'TIMES', substack: 'SUBSTACK',
        documentation: 'repeat(times): — repete o corpo.'
    }),
    forever: Object.freeze({
        opcode: 'control_forever', substack: 'SUBSTACK', documentation: 'forever: — repete para sempre.'
    }),
    if: Object.freeze({opcode: 'control_if', argumentInput: 'CONDITION', substack: 'SUBSTACK'}),
    if_else: Object.freeze({opcode: 'control_if_else', argumentInput: 'CONDITION', substack: 'SUBSTACK', alternateSubstack: 'SUBSTACK2'}),
    repeat_until: Object.freeze({opcode: 'control_repeat_until', argumentInput: 'CONDITION', substack: 'SUBSTACK'})
});

const eventRegistry = Object.freeze({
    green_flag: Object.freeze({opcode: 'event_whenflagclicked', arguments: [], documentation: 'on green_flag:'}),
    clicked: Object.freeze({
        opcode: 'event_whenthisspriteclicked', stageOpcode: 'event_whenstageclicked', arguments: [], documentation: 'on clicked:'
    }),
    key_pressed: Object.freeze({
        opcode: 'event_whenkeypressed', arguments: [Object.freeze({name: 'key', role: 'field', field: 'KEY_OPTION'})],
        documentation: 'on key_pressed("space"):'
    }),
    receive: Object.freeze({
        opcode: 'event_whenbroadcastreceived', arguments: [Object.freeze({name: 'message', role: 'broadcast-field', field: 'BROADCAST_OPTION'})],
        documentation: 'on receive("message"):'
    }),
    backdrop_switches: Object.freeze({
        opcode: 'event_whenbackdropswitchesto', arguments: [Object.freeze({name: 'backdrop', role: 'field', field: 'BACKDROP'})],
        documentation: 'on backdrop_switches("backdrop"):'
    }),
    loudness_greater_than: Object.freeze({
        opcode: 'event_whengreaterthan', arguments: [numberInput('value', 'VALUE')],
        staticFields: {WHENGREATERTHANMENU: 'LOUDNESS'}, documentation: 'on loudness_greater_than(10):'
    }),
    timer_greater_than: Object.freeze({
        opcode: 'event_whengreaterthan', arguments: [numberInput('value', 'VALUE')],
        staticFields: {WHENGREATERTHANMENU: 'TIMER'}, documentation: 'on timer_greater_than(10):'
    }),
    clone_started: Object.freeze({
        opcode: 'control_start_as_clone', arguments: [], allowStage: false, documentation: 'on clone_started:'
    })
});

module.exports = {
    blockRegistry,
    controlRegistry,
    eventRegistry,
    menuInput,
    numberInput,
    operatorRegistry,
    textInput,
    valueInput
};
