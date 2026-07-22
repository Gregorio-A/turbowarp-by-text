'use strict';

const blockTypeToKind = blockType => {
    switch (blockType) {
    case 'command': return 'command';
    case 'reporter': return 'reporter';
    case 'Boolean': return 'boolean';
    case 'hat': return 'hat';
    case 'event': return 'event';
    case 'conditional': return 'conditional';
    case 'loop': return 'loop';
    case 'button': return 'button';
    case 'label': return 'label';
    case 'xml': return 'xml';
    default: return null;
    }
};

const typeDefaults = Object.freeze({
    number: {valueType: 'number', shadowOpcode: 'math_number', shadowField: 'NUM', defaultValue: 0},
    angle: {valueType: 'number', shadowOpcode: 'math_angle', shadowField: 'NUM', defaultValue: 90},
    note: {valueType: 'number', shadowOpcode: 'note', shadowField: 'NOTE', defaultValue: 60},
    color: {valueType: 'string', shadowOpcode: 'colour_picker', shadowField: 'COLOUR', defaultValue: '#ff0000'},
    Boolean: {valueType: 'boolean', shadowOpcode: 'text', shadowField: 'TEXT', defaultValue: false},
    string: {valueType: 'any', shadowOpcode: 'text', shadowField: 'TEXT', defaultValue: ''},
    matrix: {valueType: 'string', shadowOpcode: 'matrix', shadowField: 'MATRIX', defaultValue: ''},
    costume: {valueType: 'string', shadowOpcode: 'text', shadowField: 'TEXT', defaultValue: ''},
    sound: {valueType: 'string', shadowOpcode: 'text', shadowField: 'TEXT', defaultValue: ''}
});

const formatText = value => {
    if (typeof value === 'string') return value;
    if (value && typeof value.default === 'string') return value.default;
    if (value && typeof value.defaultMessage === 'string') return value.defaultMessage;
    return '';
};

const extensionArgument = (extensionId, name, info) => {
    const defaults = typeDefaults[info.type] || typeDefaults.string;
    if (info.menu) return {
        name: name.toLowerCase(),
        originalName: name,
        role: 'menu',
        valueType: defaults.valueType,
        input: name,
        menuOpcode: `${extensionId}_menu_${info.menu}`,
        menuField: name,
        defaultValue: Object.prototype.hasOwnProperty.call(info, 'defaultValue') ? info.defaultValue : defaults.defaultValue
    };
    return {
        name: name.toLowerCase(),
        originalName: name,
        role: 'input',
        valueType: defaults.valueType,
        input: name,
        shadowOpcode: defaults.shadowOpcode,
        shadowField: defaults.shadowField,
        defaultValue: Object.prototype.hasOwnProperty.call(info, 'defaultValue') ? info.defaultValue : defaults.defaultValue
    };
};

const buildExtensionInventory = runtimeOrVm => {
    const runtime = runtimeOrVm && runtimeOrVm.runtime ? runtimeOrVm.runtime : runtimeOrVm;
    const catalog = {};
    const palette = [];
    if (!runtime || !Array.isArray(runtime._blockInfo)) return {catalog, palette};

    runtime._blockInfo.forEach(category => {
        if (!category || !category.id || !Array.isArray(category.blocks)) return;
        category.blocks.forEach((converted, index) => {
            const info = converted && converted.info;
            const json = converted && converted.json;
            if (!info) return;
            const kind = blockTypeToKind(info.blockType);
            if (!kind) {
                if (converted.xml && /^\s*<sep\b/i.test(converted.xml)) palette.push({
                    extensionId: category.id,
                    extensionName: category.name || category.id,
                    canonicalName: `${category.id}.@separator.${index}`,
                    kind: 'separator',
                    xml: converted.xml
                });
                return;
            }
            if (!json || !info.opcode) {
                const nativeButtons = ['MAKE_A_LIST', 'MAKE_A_PROCEDURE', 'MAKE_A_VARIABLE'];
                const actionId = kind === 'button' && info.func && !nativeButtons.includes(info.func) ?
                    `${category.id}_${info.func}` : null;
                palette.push({
                    extensionId: category.id,
                    extensionName: category.name || category.id,
                    canonicalName: `${category.id}.@${kind}.${info.func || index}`,
                    kind,
                    text: formatText(info.text),
                    actionId,
                    xml: converted.xml || info.xml || ''
                });
                return;
            }
            const canonicalName = `${category.id}.${info.opcode}`;
            const metadata = {
                canonicalName,
                extensionId: category.id,
                extensionName: category.name || category.id,
                extensionOpcode: info.opcode,
                opcode: json.type || `${category.id}_${info.opcode}`,
                kind,
                allowStage: !Array.isArray(info.filter) || info.filter.includes('stage'),
                terminal: Boolean(info.isTerminal || info.terminal),
                branchCount: info.branchCount || 0,
                arguments: Object.entries(info.arguments || {}).map(([name, argumentInfo]) =>
                    extensionArgument(category.id, name, argumentInfo || {})
                ),
                documentation: `${canonicalName} — ${formatText(info.text) || 'bloco de extensão'}`,
                color: category.color1 || null
            };
            if (info.isDynamic) metadata.mutation = {
                tagName: 'mutation',
                children: [],
                blockInfo: JSON.stringify(info)
            };
            catalog[canonicalName] = metadata;
            palette.push(Object.assign({text: formatText(info.text), xml: converted.xml || ''}, metadata));
        });
    });
    return {catalog, palette};
};

const buildExtensionCatalog = runtimeOrVm => buildExtensionInventory(runtimeOrVm).catalog;

const summarizeExtensionCatalog = catalog => {
    const entries = Object.values(catalog || {});
    return {
        extensionCount: new Set(entries.map(item => item.extensionId)).size,
        blockCount: entries.length,
        extensions: Array.from(new Set(entries.map(item => item.extensionId))).sort()
    };
};

module.exports = {
    blockTypeToKind,
    buildExtensionCatalog,
    buildExtensionInventory,
    extensionArgument,
    summarizeExtensionCatalog
};
