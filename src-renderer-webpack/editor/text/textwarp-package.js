'use strict';

const JSZip = require('@turbowarp/jszip');

const {compileText} = require('./compiler');
const {decompileTarget, sanitizeIdentifier} = require('./decompiler');
const {buildExtensionCatalog} = require('./extension-catalog');
const {applyCompilation, readSourceRecord, writeSourceRecord} = require('./vm-adapter');

const FORMAT_NAME = 'textwarp-project';
const FORMAT_VERSION = 1;

const asArrayBuffer = value => {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return value;
};

const safeModuleFilename = (module, index) => {
    const kind = module.isStage ? 'stage' : sanitizeIdentifier(module.name, `actor_${index + 1}`).toLowerCase();
    const identity = sanitizeIdentifier(module.moduleId, String(index + 1)).slice(0, 48);
    return `sources/${kind}-${identity}.tw`;
};

const packTextwarp = async ({projectData, modules, extensions = [], metadata = {}}) => {
    const zip = new JSZip();
    const compiledBytes = asArrayBuffer(projectData);
    const compiledZip = await JSZip.loadAsync(compiledBytes);
    const manifestModules = modules.map((module, index) => Object.assign({}, module, {
        source: safeModuleFilename(module, index)
    }));
    const manifest = {
        format: FORMAT_NAME,
        formatVersion: FORMAT_VERSION,
        languageVersion: '0.3',
        name: metadata.name || 'TextWarp Project',
        createdAt: metadata.createdAt || new Date().toISOString(),
        compiledProject: 'compiled/project.sb3',
        projectJson: 'project/project.json',
        modules: manifestModules.map(module => ({
            moduleId: module.moduleId,
            targetId: module.targetId || null,
            name: module.name,
            isStage: Boolean(module.isStage),
            source: module.source
        })),
        extensions: 'extensions/lock.json'
    };

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('compiled/project.sb3', compiledBytes);
    zip.file('extensions/lock.json', JSON.stringify({formatVersion: 1, extensions}, null, 2));
    manifestModules.forEach(module => zip.file(module.source, module.sourceText || ''));

    const projectJsonFile = compiledZip.file('project.json');
    if (projectJsonFile) zip.file('project/project.json', await projectJsonFile.async('uint8array'));
    await Promise.all(Object.values(compiledZip.files).map(async file => {
        if (file.dir || file.name === 'project.json') return;
        zip.file(`assets/${file.name}`, await file.async('uint8array'));
    }));
    return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE', compressionOptions: {level: 6}});
};

const unpackTextwarp = async data => {
    const zip = await JSZip.loadAsync(asArrayBuffer(data));
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) throw new Error('Pacote .textwarp inválido: manifest.json não encontrado.');
    let manifest;
    try {
        manifest = JSON.parse(await manifestFile.async('string'));
    } catch (error) {
        throw new Error(`Pacote .textwarp inválido: ${error.message}`);
    }
    if (manifest.format !== FORMAT_NAME || manifest.formatVersion !== FORMAT_VERSION) {
        throw new Error(`Formato .textwarp não suportado: ${manifest.format || 'desconhecido'} v${manifest.formatVersion}.`);
    }
    const modules = [];
    for (const module of manifest.modules || []) {
        const sourceFile = zip.file(module.source);
        if (!sourceFile) throw new Error(`Fonte ausente no pacote: ${module.source}.`);
        modules.push(Object.assign({}, module, {sourceText: await sourceFile.async('string')}));
    }
    let projectData = null;
    const compiled = zip.file(manifest.compiledProject || 'compiled/project.sb3');
    if (compiled) {
        projectData = await compiled.async('arraybuffer');
    } else {
        const projectJson = zip.file(manifest.projectJson || 'project/project.json');
        if (!projectJson) throw new Error('O pacote não contém o projeto compilado nem project/project.json.');
        const rebuilt = new JSZip();
        rebuilt.file('project.json', await projectJson.async('uint8array'));
        await Promise.all(Object.values(zip.files).map(async file => {
            if (file.dir || !file.name.startsWith('assets/')) return;
            rebuilt.file(file.name.slice('assets/'.length), await file.async('uint8array'));
        }));
        projectData = await rebuilt.generateAsync({type: 'arraybuffer'});
    }
    const lockFile = zip.file(manifest.extensions || 'extensions/lock.json');
    const lock = lockFile ? JSON.parse(await lockFile.async('string')) : {extensions: []};
    return {manifest, modules, extensions: lock.extensions || [], projectData};
};

const originalTargets = vm => (vm.runtime.targets || []).filter(target => target.isStage || target.isOriginal !== false);

const exportTextwarpProject = async (vm, metadata = {}) => {
    if (!vm || typeof vm.saveProjectSb3 !== 'function') throw new Error('A VM não pode salvar um projeto SB3.');
    const extensionCatalog = buildExtensionCatalog(vm);
    const modules = originalTargets(vm).map(target => {
        const record = readSourceRecord(target);
        const decompiled = record ? null : decompileTarget(target, {extensionCatalog});
        return {
            moduleId: record && record.moduleId ? record.moduleId : target.id,
            targetId: target.id,
            name: target.getName ? target.getName() : target.sprite && target.sprite.name || (target.isStage ? 'Stage' : 'Actor'),
            isStage: target.isStage,
            sourceText: record ? record.source : decompiled.source
        };
    });
    const extensionURLs = vm.extensionManager && typeof vm.extensionManager.getExtensionURLs === 'function' ?
        vm.extensionManager.getExtensionURLs() : {};
    const extensions = Object.values(extensionCatalog).reduce((result, item) => {
        if (result.some(extension => extension.id === item.extensionId)) return result;
        result.push({
            id: item.extensionId,
            url: extensionURLs[item.extensionId] || null,
            blockCount: Object.values(extensionCatalog).filter(block => block.extensionId === item.extensionId).length
        });
        return result;
    }, []);
    return packTextwarp({projectData: await vm.saveProjectSb3('arraybuffer'), modules, extensions, metadata});
};

const variableOptions = (vm, target, generatedVariables) => {
    const result = [];
    const generated = new Set((generatedVariables || []).map(item => item.id));
    const append = (owner, ownerName) => Object.values(owner && owner.variables || {}).forEach(variable => {
        if (variable.type === 'broadcast_msg') return;
        result.push({
            id: variable.id,
            name: variable.name,
            variableType: variable.type,
            owner: ownerName,
            generated: generated.has(variable.id)
        });
    });
    append(target, 'target');
    const stage = vm.runtime.getTargetForStage && vm.runtime.getTargetForStage();
    if (stage && stage !== target) append(stage, 'stage');
    return result;
};

const targetForModule = (vm, module, usedTargets) => {
    if (module.isStage) return vm.runtime.getTargetForStage && vm.runtime.getTargetForStage();
    const targets = originalTargets(vm).filter(target => !target.isStage && !usedTargets.has(target.id));
    return targets.find(target => (target.getName ? target.getName() : target.sprite && target.sprite.name) === module.name) || targets[0];
};

const importTextwarpProject = async (vm, data) => {
    if (!vm || typeof vm.loadProject !== 'function') throw new Error('A VM não pode abrir projetos.');
    const unpacked = await unpackTextwarp(data);
    await vm.loadProject(unpacked.projectData);
    const stageModule = unpacked.modules.find(module => module.isStage);
    const stageId = stageModule ? stageModule.moduleId : vm.runtime.getTargetForStage().id;
    const extensionCatalog = buildExtensionCatalog(vm);
    const diagnostics = [];
    const usedTargets = new Set();
    const orderedModules = unpacked.modules.slice().sort((left, right) => Number(right.isStage) - Number(left.isStage));

    orderedModules.forEach(module => {
        const target = targetForModule(vm, module, usedTargets);
        if (!target) {
            diagnostics.push({module: module.name, success: false, diagnostics: [{message: 'Alvo correspondente não encontrado.'}]});
            return;
        }
        usedTargets.add(target.id);
        const existing = readSourceRecord(target);
        const seedRecord = Object.assign({}, existing || {}, {
            source: module.sourceText,
            moduleId: module.moduleId || target.id,
            languageVersion: unpacked.manifest.languageVersion || '0.3'
        });
        const record = writeSourceRecord(vm, target, seedRecord);
        const generatedAcrossProject = new Set(originalTargets(vm).flatMap(runtimeTarget => {
            const runtimeRecord = readSourceRecord(runtimeTarget);
            return runtimeRecord ? runtimeRecord.generatedVariables : [];
        }).map(item => item.id));
        const compilation = compileText(module.sourceText, {
            targetId: record.moduleId,
            stageId,
            targetName: target.getName ? target.getName() : module.name,
            isStage: target.isStage,
            variables: variableOptions(vm, target, record.generatedVariables),
            broadcasts: Object.values(vm.runtime.getTargetForStage().variables || {})
                .filter(variable => variable.type === 'broadcast_msg')
                .map(variable => ({
                    id: variable.id,
                    name: variable.name,
                    generated: generatedAcrossProject.has(variable.id)
                })),
            extensionCatalog
        });
        if (compilation.success) applyCompilation(vm, target, compilation);
        diagnostics.push({module: module.name, success: compilation.success, diagnostics: compilation.diagnostics});
    });
    if (typeof vm.emitTargetsUpdate === 'function') vm.emitTargetsUpdate();
    if (typeof vm.emitWorkspaceUpdate === 'function') vm.emitWorkspaceUpdate();
    return Object.assign({}, unpacked, {diagnostics});
};

module.exports = {
    FORMAT_NAME,
    FORMAT_VERSION,
    exportTextwarpProject,
    importTextwarpProject,
    packTextwarp,
    unpackTextwarp
};
