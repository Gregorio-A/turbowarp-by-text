'use strict';

const {blockRegistry, controlRegistry, eventRegistry} = require('./block-registry');

let monacoPromise = null;
let languageRegistered = false;

const configureLanguage = monaco => {
    if (languageRegistered) return;
    languageRegistered = true;
    monaco.languages.register({id: 'textwarp'});
    monaco.languages.setLanguageConfiguration('textwarp', {
        comments: {lineComment: '#'},
        brackets: [['(', ')'], ['[', ']']],
        autoClosingPairs: [
            {open: '"', close: '"'},
            {open: "'", close: "'"},
            {open: '(', close: ')'},
            {open: '[', close: ']'}
        ],
        indentationRules: {
            increaseIndentPattern: /:\s*(?:#.*)?$/,
            decreaseIndentPattern: /^\s*$/
        }
    });
    monaco.languages.setMonarchTokensProvider('textwarp', {
        keywords: [
            'actor', 'stage', 'on', 'global', 'variable', 'list', 'procedure',
            'if', 'else', 'repeat', 'repeat_until', 'while', 'forever',
            'return', 'warp', 'branch', 'pass', 'any', 'number', 'string', 'boolean',
            'and', 'or', 'not', 'true', 'false'
        ].concat(Object.keys(eventRegistry)),
        commands: Object.keys(blockRegistry),
        tokenizer: {
            root: [
                [/#.*$/, 'comment'],
                [/[a-zA-Z_][\w]*/, {
                    cases: {
                        '@keywords': 'keyword',
                        '@commands': 'type.identifier',
                        '@default': 'identifier'
                    }
                }],
                [/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i, 'number'],
                [/"([^"\\]|\\.)*$/, 'string.invalid'],
                [/'([^'\\]|\\.)*$/, 'string.invalid'],
                [/"/, 'string', '@doubleQuotedString'],
                [/'/, 'string', '@singleQuotedString'],
                [/[()[\]:,]/, 'delimiter'],
                [/[+\-*\/%<>=!]+/, 'operator']
            ],
            doubleQuotedString: [
                [/[^\\"]+/, 'string'],
                [/\\./, 'string.escape'],
                [/"/, 'string', '@pop']
            ],
            singleQuotedString: [
                [/[^\\']+/, 'string'],
                [/\\./, 'string.escape'],
                [/'/, 'string', '@pop']
            ]
        }
    });
    monaco.languages.registerCompletionItemProvider('textwarp', {
        provideCompletionItems: () => {
            const snippet = monaco.languages.CompletionItemKind.Snippet;
            const suggestions = [
                {
                    label: 'repeat',
                    kind: snippet,
                    documentation: controlRegistry.repeat.documentation,
                    insertText: 'repeat(${1:10}):\n    ${2:move(10)}',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                },
                {
                    label: 'forever',
                    kind: snippet,
                    documentation: controlRegistry.forever.documentation,
                    insertText: 'forever:\n    ${1:move(10)}',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                },
                {
                    label: 'repeat_until',
                    kind: snippet,
                    documentation: controlRegistry.repeat_until.documentation,
                    insertText: 'repeat_until(${1:true}):\n    ${2:wait(0)}',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                },
                {
                    label: 'while',
                    kind: snippet,
                    documentation: controlRegistry.while.documentation,
                    insertText: 'while(${1:true}):\n    ${2:wait(0)}',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                },
                {
                    label: 'if',
                    kind: snippet,
                    documentation: 'Condição com ramificações opcionais.',
                    insertText: 'if ${1:key_pressed("space")}:\n    ${2:say("sim")}\nelse:\n    ${3:say("não")}',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                },
                {
                    label: 'procedure',
                    kind: snippet,
                    documentation: 'Declara um procedimento local do ator.',
                    insertText: 'procedure ${1:name}(${2:amount: number}):\n    ${3:change_x(amount)}',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                },
                {
                    label: 'procedure com retorno',
                    kind: snippet,
                    documentation: 'Declara um procedimento repórter; acrescente warp para executar sem atualização de tela.',
                    insertText: 'procedure ${1:name}(${2:value: number}) -> ${3:number}:\n    return ${4:value}',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                },
                {
                    label: 'variable',
                    kind: snippet,
                    documentation: 'Declara uma variável.',
                    insertText: 'variable ${1:name} = ${2:0}',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                },
                {
                    label: 'list',
                    kind: snippet,
                    documentation: 'Declara uma lista.',
                    insertText: 'list ${1:items} = [${2}]',
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                }
            ];
            Object.entries(eventRegistry).forEach(([name, metadata]) => {
                const examples = (metadata.arguments || []).map((argument, index) =>
                    `\${${index + 1}:${argument.name === 'value' ? '10' : '"value"'}}`
                );
                suggestions.push({
                    label: `on ${name}`,
                    kind: snippet,
                    documentation: metadata.documentation,
                    insertText: `on ${name}${examples.length ? `(${examples.join(', ')})` : ''}:\n    \${${examples.length + 1}:wait(0)}`,
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                });
            });
            Object.entries(blockRegistry).forEach(([name, metadata]) => {
                const placeholders = metadata.arguments.map((argument, index) => {
                    const example = argument.role === 'list' ? 'items' : argument.role === 'variable' ? 'value' :
                        argument.valueType === 'boolean' ? 'true' :
                            argument.valueType === 'string' || ['menu', 'broadcast', 'field'].includes(argument.role) ?
                                '"value"' : argument.name === 'seconds' ? '1' : '10';
                    return `\${${index + 1}:${example}}`;
                });
                const bodyPlaceholder = placeholders.length + 1;
                let insertText = `${name}(${placeholders.join(', ')})`;
                if (['conditional', 'loop'].includes(metadata.kind)) {
                    insertText += `:\n    \${${bodyPlaceholder}:wait(0)}`;
                    for (let branch = 2; branch <= Math.max(1, Number(metadata.branchCount) || 1); branch++) {
                        insertText += `\nbranch ${branch}:\n    \${${bodyPlaceholder + branch - 1}:wait(0)}`;
                    }
                }
                suggestions.push({
                    label: name,
                    kind: monaco.languages.CompletionItemKind.Function,
                    documentation: metadata.documentation,
                    insertText,
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                });
            });
            Object.values(window.__textwarpExtensionCatalog || {}).forEach(metadata => {
                const placeholders = (metadata.arguments || []).map((argument, index) => {
                    const example = argument.valueType === 'number' ? '1' :
                        argument.valueType === 'boolean' ? 'true' : '"value"';
                    return `\${${index + 1}:${example}}`;
                });
                const bodyPlaceholder = placeholders.length + 1;
                let insertText = `${metadata.canonicalName}(${placeholders.join(', ')})`;
                if (metadata.kind === 'hat' || metadata.kind === 'event') {
                    insertText = `on ${insertText}:\n    \${${bodyPlaceholder}:wait(0)}`;
                } else if (['conditional', 'loop'].includes(metadata.kind)) {
                    insertText += `:\n    \${${bodyPlaceholder}:wait(0)}`;
                    for (let branch = 2; branch <= Math.max(1, Number(metadata.branchCount) || 1); branch++) {
                        insertText += `\nbranch ${branch}:\n    \${${bodyPlaceholder + branch - 1}:wait(0)}`;
                    }
                }
                suggestions.push({
                    label: metadata.canonicalName,
                    kind: metadata.kind === 'hat' || metadata.kind === 'event' ? snippet :
                        monaco.languages.CompletionItemKind.Function,
                    documentation: metadata.documentation,
                    insertText,
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                });
            });
            return {suggestions};
        }
    });
};

const loadMonaco = () => {
    if (monacoPromise) return monacoPromise;
    monacoPromise = new Promise((resolve, reject) => {
        if (window.monaco && window.monaco.editor) {
            configureLanguage(window.monaco);
            resolve(window.monaco);
            return;
        }

        const baseUrl = new URL('static/monaco/vs', document.baseURI).href.replace(/\/$/, '');
        window.MonacoEnvironment = {
            getWorkerUrl: () => {
                const workerScript = [
                    `self.MonacoEnvironment = {baseUrl: ${JSON.stringify(`${baseUrl}/`)}};`,
                    `importScripts(${JSON.stringify(`${baseUrl}/base/worker/workerMain.js`)});`
                ].join('');
                return `data:text/javascript;charset=utf-8,${encodeURIComponent(workerScript)}`;
            }
        };

        const script = document.createElement('script');
        script.src = `${baseUrl}/loader.js`;
        script.onload = () => {
            const amdRequire = window.require;
            if (!amdRequire || typeof amdRequire.config !== 'function') {
                reject(new Error('O carregador AMD do Monaco não foi inicializado.'));
                return;
            }
            amdRequire.config({paths: {vs: baseUrl}});
            amdRequire(['vs/editor/editor.main'], () => {
                configureLanguage(window.monaco);
                resolve(window.monaco);
            }, reject);
        };
        script.onerror = () => reject(new Error(`Não foi possível carregar ${script.src}.`));
        document.head.appendChild(script);
    });
    return monacoPromise;
};

module.exports = {
    loadMonaco
};
