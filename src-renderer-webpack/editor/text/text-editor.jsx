import classNames from 'classnames';
import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';
import VisualBlocks from 'scratch-gui/src/containers/blocks.jsx';
import {setProjectUnchanged} from 'scratch-gui/src/reducers/project-changed';
import {setFileHandle} from 'scratch-gui/src/reducers/tw';

import {showSaveFilePicker} from '../gui/filesystem-api.js';
import {compileText} from './compiler';
import {getDebugController} from './debug-controller';
import {inspectExpression} from './debug-inspector';
import {decompileTarget} from './decompiler';
import DocumentationPane from './documentation-pane.jsx';
import {buildExtensionInventory, summarizeExtensionCatalog} from './extension-catalog';
import IdeSidebar from './ide-sidebar.jsx';
import {getDiagnosticSuggestion, getOutline} from './language-service';
import MonacoEditor from './monaco-editor.jsx';
import {mergeVisualSource} from './source-merge';
import {exportTextwarpProject, importTextwarpProject} from './textwarp-package';
import {
    clearTextwarpHandle,
    getTextwarpHandle,
    getTextwarpSuggestedName,
    setTextwarpHandle
} from './textwarp-session';
import {
    adoptImportedRoots,
    applyCompilation,
    markGeneratedRootsDirty,
    readSourceRecord,
    saveBreakpoints,
    saveTextSource
} from './vm-adapter';
import {
    buildWorkspace,
    loadHistory,
    loadRecentTargets,
    rememberRecentTarget,
    replaceWorkspace,
    saveHistorySnapshot,
    searchWorkspace,
    synchronizeStableReferences,
    targetFileName
} from './workspace-service';
import styles from './text-editor.css';

const AUTO_COMPILE_DELAY = 300;
const HISTORY_DELAY = 1200;
const emptyWorkspace = () => ({modules: [], resources: [], editableFiles: [], generatedFiles: []});
const DEFAULT_SHORTCUTS = Object.freeze({
    compile: 'F7',
    run: 'Ctrl+Enter',
    runSelection: 'Ctrl+Shift+Enter',
    stop: 'Shift+F5',
    restart: 'Ctrl+Shift+F5',
    format: 'Ctrl+Shift+I'
});
const IDE_TEMPLATES = Object.freeze([
    {
        id: 'movement',
        name: 'Ator com movimento',
        scope: 'actor',
        source: name => `actor ${name}\n\nvariable speed = 5\n\non green_flag:\n    forever:\n        if key_pressed("right"):\n            change_x(speed)\n        if key_pressed("left"):\n            change_x(-speed)\n        if key_pressed("up"):\n            change_y(speed)\n        if key_pressed("down"):\n            change_y(-speed)\n        wait(0)\n`
    },
    {
        id: 'animation',
        name: 'Ator animado',
        scope: 'actor',
        source: name => `actor ${name}\n\nvariable frame_time = 0.12\n\non green_flag:\n    forever:\n        next_costume()\n        wait(frame_time)\n`
    },
    {
        id: 'game-stage',
        name: 'Palco de jogo',
        scope: 'stage',
        source: () => 'stage\n\nglobal variable score = 0\nglobal variable lives = 3\n\non green_flag:\n    score = 0\n    lives = 3\n    broadcast("start-game")\n\non receive("game-over"):\n    stop_all()\n'
    }
]);

const getTemplate = target => target && target.isStage ? `stage

global variable score = 0
global list messages = []

on green_flag:
    score = 0
    broadcast("start-game")

on receive("game-over"):
    stop_all()` : `actor ${target ? target.getName() : 'Actor'}

variable speed = 5
variable health = 100
list hits = []

procedure take_damage(amount):
    health -= amount
    list_add(hits, amount)

on green_flag:
    go_to(0, 0)
    forever:
        if key_pressed("right"):
            change_x(speed)
        if key_pressed("left"):
            change_x(-speed)
        wait(0)

on clone_started:
    show()`;

const countErrors = diagnostics => diagnostics.filter(item => item.severity === 'error').length;

const sortedObject = value => Object.keys(value || {}).sort().reduce((result, key) => {
    result[key] = value[key];
    return result;
}, {});

const blockFingerprint = target => {
    if (!target || !target.blocks || !target.blocks._blocks) return '';
    const blocks = Object.values(target.blocks._blocks).sort((left, right) => left.id.localeCompare(right.id)).map(block => ({
        id: block.id,
        opcode: block.opcode,
        next: block.next,
        parent: block.parent,
        topLevel: Boolean(block.topLevel),
        shadow: Boolean(block.shadow),
        fields: sortedObject(block.fields),
        inputs: sortedObject(block.inputs),
        mutation: block.mutation || null
    }));
    const variables = Object.values(target.variables || {}).map(variable => ({
        id: variable.id,
        name: variable.name,
        type: variable.type
    })).sort((left, right) => left.id.localeCompare(right.id));
    return JSON.stringify({blocks, variables});
};

class TextEditor extends React.Component {
    constructor (props) {
        super(props);
        this.state = {
            source: '',
            diagnostics: [],
            status: 'Selecione um alvo para começar.',
            statusKind: 'idle',
            targetName: '',
            isStage: false,
            viewMode: 'code',
            sidebarVisible: true,
            sidebarPanel: 'explorer',
            settingsOpen: false,
            templatesOpen: false,
            shortcuts: DEFAULT_SHORTCUTS,
            workspace: emptyWorkspace(),
            openTargetIds: [],
            searchQuery: '',
            replaceValue: '',
            docsQuery: '',
            searchResults: [],
            history: [],
            saveState: 'salvo',
            blockRefresh: 0,
            breakpoints: [],
            debugOpen: false,
            extensionsOpen: false,
            consoleOpen: false,
            debugSnapshot: {
                enabled: false, threads: [], activeLinesByTarget: {}, runtimeErrors: [], consoleEntries: [], executionState: 'stopped'
            },
            watches: [],
            watchInput: '',
            selectedThreadId: null,
            extensionSummary: {extensionCount: 0, blockCount: 0, extensions: []},
            extensionPalette: [],
            visualConflict: null,
            busy: false
        };
        this.compileTimer = null;
        this.debugController = null;
        this.unsubscribeDebugger = null;
        this.extensionCatalog = {};
        this.languageContextCache = null;
        this.lastAppliedSource = '';
        this.lastBlockFingerprint = '';
        this.blockSyncTimer = null;
        this.historyTimer = null;
        this.suppressBlockSyncUntil = 0;
        this.monacoEditor = null;
        this.secondaryMonacoEditor = null;
        this.pendingLocation = null;
        this.handleProjectLoaded = () => {
            clearTextwarpHandle(`${this.props.projectTitle || 'project'}.textwarp`);
            setTimeout(() => {
                if (this._isMounted) this.loadSelectedTarget();
            }, 0);
        };
        this.packageInput = null;
        this.handleChange = this.handleChange.bind(this);
        this.handleCompile = this.handleCompile.bind(this);
        this.handleRun = this.handleRun.bind(this);
        this.handleRunSelection = this.handleRunSelection.bind(this);
        this.handleStop = this.handleStop.bind(this);
        this.handleRestart = this.handleRestart.bind(this);
        this.handleImportBlocks = this.handleImportBlocks.bind(this);
        this.handleExportPackage = this.handleExportPackage.bind(this);
        this.handlePackageFile = this.handlePackageFile.bind(this);
        this.handleToggleBreakpoint = this.handleToggleBreakpoint.bind(this);
        this.handleExtensionsChanged = this.handleExtensionsChanged.bind(this);
        this.handleInsertExtensionXml = this.handleInsertExtensionXml.bind(this);
        this.handleProjectChanged = this.handleProjectChanged.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleSearch = this.handleSearch.bind(this);
        this.handleReplaceAll = this.handleReplaceAll.bind(this);
        this.openTarget = this.openTarget.bind(this);
        this.openLocation = this.openLocation.bind(this);
        this.openResource = this.openResource.bind(this);
        this.insertResource = this.insertResource.bind(this);
        this.restoreHistory = this.restoreHistory.bind(this);
    }

    componentDidMount () {
        this._isMounted = true;
        const storage = this.getStorage();
        try {
            const savedShortcuts = storage && JSON.parse(storage.getItem('textwarp.ide.shortcuts'));
            if (savedShortcuts) this.setState({shortcuts: Object.assign({}, DEFAULT_SHORTCUTS, savedShortcuts)});
        } catch (error) {
            // Invalid local preferences are ignored and defaults remain active.
        }
        this.refreshExtensionCatalog();
        this.debugController = getDebugController(this.props.vm);
        this.unsubscribeDebugger = this.debugController.subscribe(debugSnapshot => this.setState({debugSnapshot}));
        this.syncAllBreakpoints();
        if (this.props.vm.runtime && typeof this.props.vm.runtime.on === 'function') {
            this.props.vm.runtime.on('EXTENSION_ADDED', this.handleExtensionsChanged);
            this.props.vm.runtime.on('BLOCKSINFO_UPDATE', this.handleExtensionsChanged);
            this.props.vm.runtime.on('PROJECT_LOADED', this.handleProjectLoaded);
        }
        if (typeof this.props.vm.on === 'function') this.props.vm.on('PROJECT_CHANGED', this.handleProjectChanged);
        document.addEventListener('keydown', this.handleKeyDown, true);
        this.loadSelectedTarget();
    }

    componentDidUpdate (previousProps) {
        if (
            previousProps.editingTargetId !== this.props.editingTargetId ||
            previousProps.editingTargetName !== this.props.editingTargetName
        ) this.loadSelectedTarget();
    }

    componentWillUnmount () {
        this._isMounted = false;
        clearTimeout(this.compileTimer);
        clearTimeout(this.blockSyncTimer);
        clearTimeout(this.historyTimer);
        if (this.unsubscribeDebugger) this.unsubscribeDebugger();
        if (this.debugController) this.debugController.setEnabled(false);
        if (this.props.vm.runtime && typeof this.props.vm.runtime.removeListener === 'function') {
            this.props.vm.runtime.removeListener('EXTENSION_ADDED', this.handleExtensionsChanged);
            this.props.vm.runtime.removeListener('BLOCKSINFO_UPDATE', this.handleExtensionsChanged);
            this.props.vm.runtime.removeListener('PROJECT_LOADED', this.handleProjectLoaded);
        }
        if (typeof this.props.vm.removeListener === 'function') this.props.vm.removeListener('PROJECT_CHANGED', this.handleProjectChanged);
        document.removeEventListener('keydown', this.handleKeyDown, true);
    }

    getTarget () {
        if (!this.props.vm || !this.props.vm.runtime) return null;
        return this.props.vm.runtime.getTargetById(this.props.editingTargetId) || this.props.vm.editingTarget;
    }

    getStage () {
        return this.props.vm.runtime.getTargetForStage ? this.props.vm.runtime.getTargetForStage() :
            this.props.vm.runtime.targets.find(target => target.isStage);
    }

    getProjectStorageId () {
        const stage = this.getStage();
        return `${this.props.projectTitle || 'project'}:${stage && stage.id || 'stage'}`;
    }

    getStorage () {
        try {
            return typeof window !== 'undefined' ? window.localStorage : null;
        } catch (error) {
            return null;
        }
    }

    updateShortcut (name, value) {
        const shortcuts = Object.assign({}, this.state.shortcuts, {[name]: value});
        this.setState({shortcuts});
        const storage = this.getStorage();
        try {
            if (storage) storage.setItem('textwarp.ide.shortcuts', JSON.stringify(shortcuts));
        } catch (error) {
            this.setState({status: 'Atalho aplicado nesta sessão; o armazenamento local está indisponível.', statusKind: 'working'});
        }
    }

    applyTemplate (template) {
        const target = this.getTarget();
        if (!target) return;
        if (this.state.source.trim() && typeof window !== 'undefined' && !window.confirm(
            `Substituir ${targetFileName(target)} pelo modelo “${template.name}”? A versão atual continuará no histórico local.`
        )) return;
        saveHistorySnapshot(this.getStorage(), this.getProjectStorageId(), target.id, this.state.source, 'antes do modelo');
        this.handleChange(template.source(target.getName()));
        this.setState({templatesOpen: false, status: `Modelo “${template.name}” aplicado.`, statusKind: 'working'});
    }

    refreshWorkspace (callback) {
        const workspace = buildWorkspace(this.props.vm);
        const activeModule = workspace.modules.find(module => module.id === this.props.editingTargetId);
        if (activeModule) activeModule.source = this.state.source;
        const searchResults = searchWorkspace(workspace, this.state.searchQuery);
        this.setState({workspace, searchResults}, callback);
        return workspace;
    }

    getLanguageContext (target = this.getTarget()) {
        const workspace = this.state.workspace.modules.length ? this.state.workspace : buildWorkspace(this.props.vm);
        const targetId = target && target.id;
        if (
            this.languageContextCache && this.languageContextCache.workspace === workspace &&
            this.languageContextCache.source === this.state.source &&
            this.languageContextCache.extensionCatalog === this.extensionCatalog &&
            this.languageContextCache.targetId === targetId
        ) return this.languageContextCache.value;
        const value = {
            extensionCatalog: this.extensionCatalog,
            resources: workspace.resources,
            documents: workspace.modules.map(module => ({
                modelKey: module.id,
                targetId: module.id,
                source: module.id === this.props.editingTargetId ? this.state.source : module.source
            })),
            targetId,
            targetName: target && target.getName ? target.getName() : '',
            isStage: Boolean(target && target.isStage)
        };
        this.languageContextCache = {
            workspace,
            source: this.state.source,
            extensionCatalog: this.extensionCatalog,
            targetId,
            value
        };
        return value;
    }

    getVariableOptions (target, stored) {
        const result = [];
        const generated = new Set((stored && stored.generatedVariables || []).map(item => item.id));
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
        const stage = this.getStage();
        if (stage && stage !== target) append(stage, 'stage');
        return result;
    }

    getCompileOptions (target) {
        const stored = readSourceRecord(target);
        const stage = this.getStage();
        const stageRecord = stage && readSourceRecord(stage);
        const generatedStageVariables = new Set((this.props.vm.runtime.targets || []).flatMap(runtimeTarget => {
            const runtimeRecord = readSourceRecord(runtimeTarget);
            return runtimeRecord ? runtimeRecord.generatedVariables : [];
        }).map(item => item.id));
        return {
            targetId: stored && stored.moduleId ? stored.moduleId : target.id,
            stageId: stageRecord && stageRecord.moduleId ? stageRecord.moduleId : stage && stage.id,
            targetName: target.getName(),
            isStage: target.isStage,
            variables: this.getVariableOptions(target, stored),
            broadcasts: Object.values(stage && stage.variables || {}).filter(variable => variable.type === 'broadcast_msg').map(variable => ({
                id: variable.id,
                name: variable.name,
                generated: generatedStageVariables.has(variable.id)
            })),
            resources: buildWorkspace(this.props.vm).resources,
            extensionCatalog: this.extensionCatalog,
            availableOpcodes: Object.keys(this.props.vm.runtime._primitives || {})
        };
    }

    refreshExtensionCatalog () {
        const inventory = buildExtensionInventory(this.props.vm);
        this.extensionCatalog = inventory.catalog;
        if (typeof window !== 'undefined') window.__textwarpExtensionCatalog = this.extensionCatalog;
        const extensionSummary = summarizeExtensionCatalog(this.extensionCatalog);
        if (this._isMounted !== false) this.setState({extensionSummary, extensionPalette: inventory.palette});
        return extensionSummary;
    }

    handleExtensionsChanged () {
        this.refreshExtensionCatalog();
        const target = this.getTarget();
        if (!target) return;
        const compilation = compileText(this.state.source, this.getCompileOptions(target));
        this.setState({diagnostics: compilation.diagnostics});
    }

    handleInsertExtensionXml (entry) {
        try {
            const ScratchBlocks = typeof window !== 'undefined' && (window.ScratchBlocks || window.Blockly);
            const workspace = ScratchBlocks && typeof ScratchBlocks.getMainWorkspace === 'function' &&
                ScratchBlocks.getMainWorkspace();
            if (!workspace || !ScratchBlocks.Xml || typeof ScratchBlocks.Xml.domToWorkspace !== 'function') {
                throw new Error('Abra a visualização Blocos ou Dividido antes de inserir XML.');
            }
            const xml = /^\s*<xml\b/i.test(entry.xml) ? entry.xml :
                `<xml xmlns="http://www.w3.org/1999/xhtml">${entry.xml}</xml>`;
            const dom = ScratchBlocks.Xml.textToDom(xml);
            const inserted = ScratchBlocks.Xml.domToWorkspace(dom, workspace) || [];
            this.setState({
                viewMode: 'split',
                extensionsOpen: false,
                status: `${Array.isArray(inserted) ? inserted.length : 1} bloco(s) inserido(s) pela paleta da extensão.`,
                statusKind: 'success'
            });
        } catch (error) {
            this.setState({status: error.message, statusKind: 'error'});
        }
    }

    handleProjectChanged () {
        if (Date.now() < this.suppressBlockSyncUntil) return;
        clearTimeout(this.blockSyncTimer);
        this.blockSyncTimer = setTimeout(() => {
            const target = this.getTarget();
            const referencesUpdated = this.synchronizeProjectReferences();
            this.refreshWorkspace();
            if (referencesUpdated) return;
            if (!target || !['blocks', 'split'].includes(this.state.viewMode)) return;
            const fingerprint = blockFingerprint(target);
            if (fingerprint === this.lastBlockFingerprint) return;
            const result = decompileTarget(target, {extensionCatalog: this.extensionCatalog});
            const compileOptions = this.getCompileOptions(target);
            const visualCompilation = compileText(result.source, compileOptions);
            result.canonicalSource = result.source;
            result.visualCompilation = visualCompilation;
            const hasPendingText = this.state.source !== this.lastAppliedSource || countErrors(this.state.diagnostics) > 0;
            const baseCompilation = this.lastAppliedSource ? compileText(this.lastAppliedSource, compileOptions) : null;
            const textCompilation = compileText(this.state.source, compileOptions);
            const merged = baseCompilation && visualCompilation.success ? mergeVisualSource({
                baseSource: this.lastAppliedSource,
                textSource: this.state.source,
                visualSource: result.canonicalSource,
                baseCompilation,
                textCompilation,
                visualCompilation
            }) : null;
            if (merged && merged.source !== null) {
                result.source = merged.source;
                result.semanticMerge = merged;
            }
            if (hasPendingText && (!merged || merged.conflicts.length > 0)) {
                this.lastBlockFingerprint = fingerprint;
                this.setState({
                    visualConflict: result,
                    status: merged && merged.conflicts.length ?
                        `Conflito semântico em ${merged.conflicts.length} unidade(s). Escolha qual versão manter.` :
                        'Texto inválido e blocos foram alterados ao mesmo tempo. Escolha qual versão manter.',
                    statusKind: 'working'
                });
                return;
            }
            this.acceptVisualChanges(result);
        }, 220);
    }

    synchronizeProjectReferences () {
        const workspace = buildWorkspace(this.props.vm);
        let currentUpdate = null;
        (this.props.vm.runtime.targets || []).forEach(target => {
            const record = readSourceRecord(target);
            if (!record) return;
            const synchronized = synchronizeStableReferences(
                record.source,
                target,
                record.resourceBindings,
                workspace.resources
            );
            if (!synchronized.count) return;
            const compilation = compileText(synchronized.source, this.getCompileOptions(target));
            if (!compilation.success) return;
            this.suppressBlockSyncUntil = Date.now() + 750;
            applyCompilation(this.props.vm, target, compilation);
            saveHistorySnapshot(
                this.getStorage(), this.getProjectStorageId(), target.id, synchronized.source, 'sincronização de recurso'
            );
            if (target.id === this.props.editingTargetId) currentUpdate = {source: synchronized.source, compilation};
        });
        if (!currentUpdate) return false;
        this.lastAppliedSource = currentUpdate.source;
        this.lastBlockFingerprint = blockFingerprint(this.getTarget());
        this.setState({
            source: currentUpdate.source,
            diagnostics: currentUpdate.compilation.diagnostics,
            status: 'Referências estáveis atualizadas após mudança no projeto.',
            statusKind: 'success'
        });
        return true;
    }

    acceptVisualChanges (result = this.state.visualConflict) {
        const target = this.getTarget();
        if (!target || !result) return;
        clearTimeout(this.compileTimer);
        const compileOptions = this.getCompileOptions(target);
        const canonicalSource = result.canonicalSource || result.source;
        const visualCompilation = result.visualCompilation || compileText(canonicalSource, compileOptions);
        const compilation = compileText(result.source, compileOptions);
        if (!visualCompilation.success || !compilation.success) {
            this.setState({
                diagnostics: compilation.diagnostics,
                status: 'A sincronização produziu uma fonte inválida; nenhuma alteração foi aplicada.',
                statusKind: 'error'
            });
            return;
        }
        this.suppressBlockSyncUntil = Date.now() + 750;
        adoptImportedRoots(
            this.props.vm,
            target,
            canonicalSource,
            result.importedRootIds,
            result.sourceMap,
            visualCompilation
        );
        // A segunda etapa atualiza somente unidades textuais que também mudaram.
        // Unidades adotadas do Blockly têm o mesmo hash e preservam seus IDs.
        const record = applyCompilation(this.props.vm, target, compilation);
        this.lastAppliedSource = result.source;
        this.lastBlockFingerprint = blockFingerprint(target);
        this.setState(state => ({
            source: result.source,
            diagnostics: compilation.diagnostics,
            visualConflict: null,
            blockRefresh: state.blockRefresh + 1,
            status: `${result.semanticMerge && result.semanticMerge.mergedUnits.length ?
                `${result.semanticMerge.mergedUnits.length} unidade(s) mesclada(s) automaticamente; ` : ''
            }blocos sincronizados (${result.importedRootIds.length} stack(s), ${
                result.unsupportedOpcodes.length
            } opcode(s) indisponível(is) mantido(s) somente em blocos, ${
                record.lastApply && record.lastApply.unchangedUnits || 0
            } unidade(s) preservada(s)).`,
            statusKind: compilation.success ? 'success' : 'error'
        }));
    }

    keepTextChanges () {
        const target = this.getTarget();
        if (!target) return;
        markGeneratedRootsDirty(target);
        this.setState({visualConflict: null}, () => this.compileCurrent(false));
    }

    setViewMode (viewMode) {
        this.setState({viewMode}, () => {
            if (typeof window !== 'undefined') window.dispatchEvent(new Event('resize'));
            if (viewMode === 'blocks' || viewMode === 'split') {
                this.lastBlockFingerprint = blockFingerprint(this.getTarget());
            }
        });
    }

    handleKeyDown (event) {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = String(event.key).toLowerCase();
        if (event.shiftKey && key === 'e') {
            event.preventDefault();
            this.setState({sidebarVisible: true, sidebarPanel: 'explorer'});
            return;
        }
        if (event.shiftKey && key === 'f') {
            event.preventDefault();
            this.setState({sidebarVisible: true, sidebarPanel: 'search'});
            return;
        }
        if (key !== 's') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.saveTextwarp(Boolean(event.shiftKey));
    }

    openTarget (targetId) {
        if (!targetId) return;
        const storage = this.getStorage();
        rememberRecentTarget(storage, this.getProjectStorageId(), targetId);
        this.setState(state => ({
            openTargetIds: state.openTargetIds.includes(targetId) ? state.openTargetIds : state.openTargetIds.concat(targetId)
        }));
        if (targetId === this.props.editingTargetId) return;
        if (typeof this.props.vm.setEditingTarget === 'function') this.props.vm.setEditingTarget(targetId);
    }

    closeTarget (event, targetId) {
        event.stopPropagation();
        this.setState(state => {
            if (state.openTargetIds.length <= 1) return null;
            const openTargetIds = state.openTargetIds.filter(id => id !== targetId);
            if (targetId === this.props.editingTargetId) {
                const nextId = openTargetIds[openTargetIds.length - 1];
                setTimeout(() => this.openTarget(nextId), 0);
            }
            return {openTargetIds};
        });
    }

    openLocation (location) {
        if (!location) return;
        this.pendingLocation = location;
        if (location.targetId && location.targetId !== this.props.editingTargetId) {
            this.openTarget(location.targetId);
            return;
        }
        this.setViewMode('code');
        setTimeout(() => {
            if (this.monacoEditor) this.monacoEditor.revealPosition(location.line || 1, location.column || 1);
            this.pendingLocation = null;
        }, 0);
    }

    openResource (resource) {
        if (!resource) return;
        const targetId = ['actor', 'stage'].includes(resource.kind) ? resource.id : resource.ownerId;
        this.openTarget(targetId);
        this.setState({
            status: `${resource.kindLabel || 'Recurso'} “${resource.name}” selecionado no projeto.`,
            statusKind: 'success'
        });
    }

    navigateResourceByName (name) {
        const resource = this.state.workspace.resources.find(item => item.name === name);
        if (resource) this.openResource(resource);
    }

    insertResource (resource) {
        this.setViewMode('code');
        setTimeout(() => {
            if (this.monacoEditor) this.monacoEditor.insertText(JSON.stringify(resource.name));
        }, 0);
    }

    handleSearch (searchQuery) {
        const workspace = buildWorkspace(this.props.vm);
        const activeModule = workspace.modules.find(module => module.id === this.props.editingTargetId);
        if (activeModule) activeModule.source = this.state.source;
        this.setState({searchQuery, workspace, searchResults: searchWorkspace(workspace, searchQuery)});
    }

    handleReplaceAll () {
        const workspace = buildWorkspace(this.props.vm);
        const activeModule = workspace.modules.find(module => module.id === this.props.editingTargetId);
        if (activeModule) activeModule.source = this.state.source;
        const replacement = replaceWorkspace(workspace, this.state.searchQuery, this.state.replaceValue);
        if (!replacement.count) return;
        if (
            typeof window !== 'undefined' &&
            !window.confirm(`Substituir ${replacement.count} ocorrência(s) em todos os scripts editáveis?`)
        ) return;
        const compilations = replacement.modules.map(module => {
            const target = this.props.vm.runtime.getTargetById(module.id);
            return {module, target, compilation: compileText(module.source, this.getCompileOptions(target))};
        });
        const invalid = compilations.find(item => !item.compilation.success);
        if (invalid) {
            this.setState({
                status: `A substituição deixaria ${invalid.module.fileName} inválido; nenhuma alteração foi aplicada.`,
                statusKind: 'error'
            });
            return;
        }
        compilations.forEach(item => {
            saveTextSource(this.props.vm, item.target, item.module.source);
            applyCompilation(this.props.vm, item.target, item.compilation);
            saveHistorySnapshot(
                this.getStorage(), this.getProjectStorageId(), item.target.id, item.module.source, 'substituição global'
            );
        });
        const current = compilations.find(item => item.target.id === this.props.editingTargetId);
        this.setState({
            source: current ? current.module.source : this.state.source,
            diagnostics: current ? current.compilation.diagnostics : this.state.diagnostics,
            status: `${replacement.count} ocorrência(s) substituída(s) em ${compilations.length} script(s).`,
            statusKind: 'success',
            saveState: 'salvo'
        }, () => this.handleSearch(this.state.searchQuery));
    }

    restoreHistory (entry) {
        if (!entry || typeof entry.source !== 'string') return;
        this.handleChange(entry.source);
        this.setState({sidebarPanel: 'explorer', status: 'Versão do histórico local restaurada.', statusKind: 'working'});
    }

    handleStop () {
        if (this.props.vm && typeof this.props.vm.stopAll === 'function') this.props.vm.stopAll();
        if (this.debugController) this.debugController.log('info', 'Parada solicitada pelo editor.');
        this.setState({status: 'Execução parada.', statusKind: 'idle'});
    }

    handleRestart () {
        if (this.props.vm && typeof this.props.vm.stopAll === 'function') this.props.vm.stopAll();
        this.setState({status: 'Reiniciando execução…', statusKind: 'working'}, () => this.compileCurrent(true));
    }

    handleRunSelection (selection) {
        const target = this.getTarget();
        if (!target || !selection) return;
        const compilation = compileText(this.state.source, this.getCompileOptions(target));
        if (!compilation.success) {
            this.setState({diagnostics: compilation.diagnostics, status: 'Corrija os erros antes da execução parcial.', statusKind: 'error'});
            return;
        }
        const startLine = selection.startLine;
        const endLine = selection.empty ? selection.startLine : selection.endLine;
        const units = compilation.graph.units.filter(unit => {
            const lines = unit.blockIds.map(id => compilation.graph.sourceMap[id] && compilation.graph.sourceMap[id].startLine).filter(Boolean);
            if (!lines.length) return false;
            const first = Math.min(...lines);
            const last = Math.max(...lines);
            return startLine <= last && endLine >= first;
        });
        const runnableUnits = units.filter(unit => unit.kind === 'script' || unit.kind === 'procedure' &&
            compilation.ir.procedures.some(procedure => procedure.name === unit.name && procedure.parameters.length === 0)
        );
        if (!runnableUnits.length) {
            this.setState({
                status: 'Selecione um evento ou um procedimento sem parâmetros; procedimentos com parâmetros precisam ser chamados pelo código.',
                statusKind: 'error'
            });
            return;
        }
        this.applyCompilation(compilation, target, false);
        runnableUnits.forEach(unit => this.props.vm.runtime.toggleScript(unit.rootId, {target, stackClick: true}));
        if (this.debugController) this.debugController.log('info', `${runnableUnits.length} unidade(s) executada(s) parcialmente.`, target);
        this.setState({status: `${runnableUnits.length} unidade(s) executada(s) a partir da seleção.`, statusKind: 'success'});
    }

    async saveTextwarp (saveAs = false) {
        if (this.state.busy) return;
        this.setState({busy: true, status: 'Salvando projeto editável .textwarp…', statusKind: 'working'});
        try {
            const target = this.getTarget();
            if (target) {
                const compilation = compileText(this.state.source, this.getCompileOptions(target));
                if (compilation.success && this.state.source !== this.lastAppliedSource) {
                    this.suppressBlockSyncUntil = Date.now() + 750;
                    applyCompilation(this.props.vm, target, compilation);
                    this.lastAppliedSource = compilation.source;
                    this.lastBlockFingerprint = blockFingerprint(target);
                }
            }
            const bytes = await exportTextwarpProject(this.props.vm, {
                name: this.props.projectTitle || 'TextWarp Project'
            });
            let handle = saveAs ? null : getTextwarpHandle();
            if (!handle) handle = await showSaveFilePicker({
                suggestedName: getTextwarpSuggestedName() || `${this.props.projectTitle || 'project'}.textwarp`
            });
            const writable = await handle.createWritable();
            try {
                await writable.write(bytes);
                await writable.close();
            } catch (error) {
                await writable.abort();
                throw error;
            }
            setTextwarpHandle(handle);
            this.props.onClearSb3FileHandle();
            if (typeof EditorPreload !== 'undefined' && handle.id !== undefined) EditorPreload.openedFile(handle.id);
            this.props.onSetProjectUnchanged();
            this.setState({status: `${handle.name || 'Projeto'} salvo como fonte editável .textwarp.`, statusKind: 'success'});
        } catch (error) {
            if (error && error.name === 'AbortError') {
                this.setState({status: 'Salvamento cancelado.', statusKind: 'idle'});
                return;
            }
            console.error(error);
            this.setState({status: error.message, statusKind: 'error'});
        } finally {
            if (this._isMounted) this.setState({busy: false});
        }
    }

    syncAllBreakpoints () {
        if (!this.debugController) return;
        let hasBreakpoints = false;
        (this.props.vm.runtime.targets || []).forEach(target => {
            const record = readSourceRecord(target);
            const breakpoints = record ? record.breakpoints : [];
            if (breakpoints.length) hasBreakpoints = true;
            this.debugController.setBreakpoints(target, breakpoints);
        });
        this.debugController.setEnabled(this.state.debugOpen || hasBreakpoints);
    }

    loadSelectedTarget () {
        clearTimeout(this.compileTimer);
        clearTimeout(this.historyTimer);
        const target = this.getTarget();
        if (!target) {
            this.setState({
                source: '', diagnostics: [], status: 'Selecione um palco ou ator.', statusKind: 'idle',
                targetName: '', isStage: false, breakpoints: []
            });
            return;
        }
        this.refreshExtensionCatalog();
        const stored = readSourceRecord(target);
        const initialSource = stored ? stored.source : getTemplate(target);
        const synchronized = stored ? synchronizeStableReferences(
            initialSource,
            target,
            stored.resourceBindings,
            buildWorkspace(this.props.vm).resources
        ) : {source: initialSource, count: 0};
        const source = synchronized.source;
        const compilation = compileText(source, this.getCompileOptions(target));
        const existingBlocks = target.blocks && target.blocks._blocks ? Object.keys(target.blocks._blocks).length : 0;
        const breakpoints = stored ? stored.breakpoints : [];
        const storage = this.getStorage();
        const projectId = this.getProjectStorageId();
        const recent = loadRecentTargets(storage, projectId);
        rememberRecentTarget(storage, projectId, target.id);
        const history = loadHistory(storage, projectId, target.id);
        const workspace = buildWorkspace(this.props.vm);
        const openTargetIds = Array.from(new Set(
            this.state.openTargetIds.concat(recent).filter(id => workspace.modules.some(module => module.id === id)).concat(target.id)
        ));
        if (this.debugController) this.debugController.setBreakpoints(target, breakpoints);
        if (synchronized.count && compilation.success) applyCompilation(this.props.vm, target, compilation);
        this.lastAppliedSource = stored ? source : '';
        this.lastBlockFingerprint = blockFingerprint(target);
        this.setState({
            source,
            diagnostics: compilation.diagnostics,
            status: synchronized.count ? 'Fonte e referências atualizadas para o estado atual do projeto.' : stored ? 'Fonte carregada do projeto.' : existingBlocks ?
                'Este alvo já tem blocos. Use “Importar blocos” para convertê-los em texto.' :
                'Exemplo inicial — edite ou compile para adicioná-lo ao projeto.',
            statusKind: stored ? 'success' : 'idle',
            targetName: target.getName(),
            isStage: target.isStage,
            breakpoints,
            workspace,
            openTargetIds,
            history,
            searchResults: searchWorkspace(workspace, this.state.searchQuery),
            saveState: 'salvo',
            visualConflict: null,
            blockRefresh: this.state.blockRefresh + 1
        }, () => {
            if (this.pendingLocation && this.pendingLocation.targetId === target.id) this.openLocation(this.pendingLocation);
        });
    }

    handleChange (source) {
        const target = this.getTarget();
        if (!target) return;
        saveTextSource(this.props.vm, target, source);
        const compilation = compileText(source, this.getCompileOptions(target));
        const errors = countErrors(compilation.diagnostics);
        this.setState({
            source,
            diagnostics: compilation.diagnostics,
            status: errors ? `${errors} erro(s); a última versão válida continua executável.` : 'Analisando alteração…',
            statusKind: errors ? 'error' : 'working',
            saveState: 'salvando'
        });
        clearTimeout(this.historyTimer);
        this.historyTimer = setTimeout(() => {
            const history = saveHistorySnapshot(
                this.getStorage(),
                this.getProjectStorageId(),
                target.id,
                source,
                'autosave'
            );
            if (this._isMounted && this.props.editingTargetId === target.id) {
                this.setState({history, saveState: 'salvo'}, () => this.refreshWorkspace());
            }
        }, HISTORY_DELAY);
        clearTimeout(this.compileTimer);
        if (compilation.success) {
            const targetId = target.id;
            this.compileTimer = setTimeout(() => {
                if (this.props.editingTargetId === targetId) this.applyCompilation(compilation, target, false);
            }, AUTO_COMPILE_DELAY);
        }
    }

    handleWorkspaceModelChange (targetId, source) {
        const target = this.props.vm.runtime.getTargetById(targetId);
        if (!target || targetId === this.props.editingTargetId) return;
        const compilation = compileText(source, this.getCompileOptions(target));
        saveTextSource(this.props.vm, target, source);
        if (compilation.success) applyCompilation(this.props.vm, target, compilation);
        saveHistorySnapshot(this.getStorage(), this.getProjectStorageId(), targetId, source, 'refatoração');
        this.refreshWorkspace();
    }

    applyCompilation (compilation, target, run) {
        try {
            this.suppressBlockSyncUntil = Date.now() + 750;
            const record = applyCompilation(this.props.vm, target, compilation);
            this.lastAppliedSource = compilation.source;
            this.lastBlockFingerprint = blockFingerprint(target);
            const apply = record.lastApply || {};
            const changed = (apply.createdUnits || 0) + (apply.updatedUnits || 0);
            const history = saveHistorySnapshot(
                this.getStorage(), this.getProjectStorageId(), target.id, compilation.source, 'autosave'
            );
            this.setState(state => ({
                diagnostics: compilation.diagnostics,
                status: `${record.generatedBlockIds.length} bloco(s) · ${changed} unidade(s) atualizada(s) · ${apply.unchangedUnits || 0} preservada(s).`,
                statusKind: 'success',
                saveState: 'salvo',
                history,
                blockRefresh: state.blockRefresh + 1
            }));
            if (run) this.props.vm.greenFlag();
        } catch (error) {
            console.error(error);
            this.setState({status: error.message, statusKind: 'error'});
        }
    }

    compileCurrent (run) {
        clearTimeout(this.compileTimer);
        const target = this.getTarget();
        if (!target) return;
        this.refreshExtensionCatalog();
        const compilation = compileText(this.state.source, this.getCompileOptions(target));
        const errors = countErrors(compilation.diagnostics);
        if (errors) {
            saveTextSource(this.props.vm, target, this.state.source);
            this.setState({
                diagnostics: compilation.diagnostics,
                status: `${errors} erro(s) impedem a compilação.`,
                statusKind: 'error'
            });
            return;
        }
        this.applyCompilation(compilation, target, run);
    }

    handleCompile () {
        this.compileCurrent(false);
    }

    handleRun () {
        this.compileCurrent(true);
    }

    handleImportBlocks () {
        const target = this.getTarget();
        if (!target) return;
        const result = decompileTarget(target, {extensionCatalog: this.extensionCatalog});
        if (result.importedRootIds.length === 0 && result.unsupportedRootIds.length === 0) {
            this.setState({status: 'Este alvo não contém stacks para importar.', statusKind: 'idle'});
            return;
        }
        if (
            this.state.source.trim() &&
            typeof window !== 'undefined' &&
            !window.confirm('Substituir o texto atual pela conversão dos blocos existentes?')
        ) return;
        const compilation = compileText(result.source, this.getCompileOptions(target));
        this.suppressBlockSyncUntil = Date.now() + 750;
        adoptImportedRoots(
            this.props.vm,
            target,
            result.source,
            result.importedRootIds,
            result.sourceMap,
            compilation
        );
        this.lastAppliedSource = result.source;
        this.lastBlockFingerprint = blockFingerprint(target);
        this.setState(state => ({
            source: result.source,
            diagnostics: compilation.diagnostics,
            status: `${result.importedRootIds.length} stack(s) convertido(s); ${result.unsupportedRootIds.length} preservado(s) como blocos.`,
            statusKind: result.unsupportedRootIds.length ? 'working' : 'success',
            visualConflict: null,
            blockRefresh: state.blockRefresh + 1
        }));
    }

    async handleExportPackage () {
        return this.saveTextwarp(true);
    }

    async handlePackageFile (event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        this.setState({busy: true, status: `Abrindo ${file.name}…`, statusKind: 'working'});
        try {
            const result = await importTextwarpProject(this.props.vm, await file.arrayBuffer());
            clearTextwarpHandle(file.name);
            this.props.onClearSb3FileHandle();
            const errors = result.diagnostics.filter(module => !module.success).length;
            this.refreshExtensionCatalog();
            this.syncAllBreakpoints();
            this.setState({
                status: errors ? `${file.name} aberto com erro em ${errors} módulo(s).` : `${file.name} aberto.`,
                statusKind: errors ? 'error' : 'success',
                busy: false
            });
            this.props.onSetProjectUnchanged();
            setTimeout(() => this.loadSelectedTarget(), 0);
        } catch (error) {
            console.error(error);
            this.setState({status: error.message, statusKind: 'error', busy: false});
        }
    }

    handleToggleBreakpoint (line) {
        const target = this.getTarget();
        if (!target) return;
        const next = new Set(this.state.breakpoints);
        if (next.has(line)) next.delete(line);
        else next.add(line);
        const breakpoints = Array.from(next).sort((left, right) => left - right);
        saveBreakpoints(this.props.vm, target, breakpoints);
        this.debugController.setBreakpoints(target, breakpoints);
        this.debugController.setEnabled(this.state.debugOpen || this.debugController.hasBreakpoints());
        this.setState({breakpoints});
    }

    toggleDebugger () {
        const debugOpen = !this.state.debugOpen;
        this.debugController.setEnabled(debugOpen || this.debugController.hasBreakpoints());
        this.setState({debugOpen, extensionsOpen: false, consoleOpen: false});
    }

    addWatch (event) {
        event.preventDefault();
        const expression = this.state.watchInput.trim();
        if (!expression || this.state.watches.includes(expression)) return;
        this.setState(state => ({watches: state.watches.concat(expression), watchInput: ''}));
    }

    getWatchValues () {
        const selected = this.state.debugSnapshot.threads.find(thread => thread.id === this.state.selectedThreadId) ||
            this.state.debugSnapshot.threads.find(thread => thread.paused);
        const target = selected && this.props.vm.runtime.getTargetById(selected.targetId) || this.getTarget();
        const stage = this.getStage();
        return this.state.watches.map(expression => Object.assign({expression}, inspectExpression(expression, target, stage)));
    }

    renderDiagnostics () {
        if (this.state.diagnostics.length === 0) return <span className={styles.noDiagnostics}>Nenhum problema encontrado.</span>;
        return this.state.diagnostics.slice(0, 8).map((item, index) => {
            const quoted = item.message.match(/[“"]([^”"]+)[”"]/);
            const helpQuery = quoted && quoted[1] || (/indent/.test(item.code) ? 'indentação' :
                /variable|list/.test(item.code) ? 'variável lista' : /procedure|parameter|return/.test(item.code) ?
                    'procedimentos parâmetros' : 'referência');
            return (
                <div className={classNames(styles.diagnostic, styles[item.severity])} key={`${item.line}:${item.column}:${item.code}:${index}`}>
                    <button title="Ir para o problema" type="button" onClick={() => this.openLocation({
                        targetId: this.props.editingTargetId, line: item.line, column: item.column
                    })}>
                        <span className={styles.diagnosticLocation}>L{item.line}:{item.column}</span>
                        <span>{item.message}</span>
                        {getDiagnosticSuggestion(item) && <em>{getDiagnosticSuggestion(item)}</em>}
                        <small>{item.code}</small>
                    </button>
                    <button className={styles.diagnosticHelp} type="button" onClick={() => this.setState({
                        docsQuery: helpQuery,
                        viewMode: 'docs'
                    })}>Ajuda</button>
                </div>
            );
        });
    }

    renderConsole () {
        const entries = this.state.debugSnapshot.consoleEntries || [];
        return (
            <div className={styles.console} aria-label="Console de saída TextWarp">
                <div className={styles.consoleActions}>
                    <strong>Console estruturado</strong>
                    <span>{this.state.debugSnapshot.executionState === 'running' ? '● executando' :
                        this.state.debugSnapshot.executionState === 'paused' ? 'Ⅱ pausado' : '■ parado'}</span>
                    <button type="button" onClick={() => this.debugController.clearConsole()}>Limpar</button>
                </div>
                <div className={styles.consoleEntries} role="log" aria-live="polite">
                    {!entries.length && <span className={styles.noDiagnostics}>A saída, perguntas e erros aparecerão aqui.</span>}
                    {entries.slice().reverse().map(entry => (
                        <button
                            className={styles[entry.level]}
                            disabled={!entry.line}
                            key={entry.id}
                            type="button"
                            onClick={() => entry.line && this.openLocation({targetId: entry.targetId, line: entry.line})}
                        >
                            <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                            <span>{entry.level}</span>
                            <code>{entry.targetName}{entry.line ? `:${entry.line}` : ''}</code>
                            <pre>{entry.message}</pre>
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    renderDebugger () {
        const snapshot = this.state.debugSnapshot;
        const selectedThread = snapshot.threads.find(thread => thread.id === this.state.selectedThreadId) ||
            snapshot.threads.find(thread => thread.paused) || snapshot.threads[0];
        const inspector = selectedThread && selectedThread.inspector;
        const watches = this.getWatchValues();
        return (
            <div className={styles.debugger}>
                <div className={styles.debugActions}>
                    <button type="button" onClick={() => this.debugController.pauseAll()}>Pausar threads</button>
                    <button type="button" onClick={() => this.debugController.resumeAll()}>Continuar todas</button>
                    <span>
                        {snapshot.threads.length} thread(s) · {this.state.breakpoints.length} breakpoint(s) · {
                            snapshot.selectiveInterpreter ? 'interpretador somente nos atores com breakpoint' :
                                snapshot.interpreterRequired ? 'interpretador para pausa global' :
                                    snapshot.jitEnabled ? 'JIT ativo' : 'interpretador do projeto'
                        }
                    </span>
                </div>
                <div className={styles.debugGrid}>
                <div className={styles.threadList}>
                    {snapshot.threads.length === 0 && <span className={styles.noDiagnostics}>Nenhuma thread ativa.</span>}
                    {snapshot.threads.map(thread => (
                        <div
                            className={classNames(styles.thread, selectedThread && selectedThread.id === thread.id && styles.selectedThread)}
                            key={thread.id}
                        >
                            <button className={styles.threadSelect} type="button" onClick={() => this.setState({selectedThreadId: thread.id})}>
                            <span className={classNames(styles.threadState, thread.paused && styles.threadPaused)}>
                                {thread.paused ? 'pausada' : 'executando'}
                            </span>
                            <strong>{thread.targetName}</strong>
                            <code>
                                {thread.line ? `linha ${thread.line}` : thread.blockId || 'sem linha'} · {
                                    thread.executionMode === 'jit' ? 'JIT' : 'interpretador'
                                }
                            </code>
                            </button>
                            {thread.paused && <>
                                <button type="button" onClick={() => this.debugController.stepThread(thread.id)}>
                                    {thread.stepGranularity === 'frame' ? 'Passo de frame' : 'Entrar'}
                                </button>
                                {thread.stepGranularity !== 'frame' && <button type="button" onClick={() =>
                                    this.debugController.stepOverThread(thread.id)
                                }>Passar</button>}
                                {thread.canStepOut && <button type="button" onClick={() =>
                                    this.debugController.stepOutThread(thread.id)
                                }>Sair</button>}
                                <button type="button" onClick={() => this.debugController.resumeThread(thread.id)}>Continuar</button>
                            </>}
                        </div>
                    ))}
                </div>
                <div className={styles.inspector}>
                    <section>
                        <h3>Variáveis e estado</h3>
                        {inspector && inspector.target && <code>
                            x {inspector.target.x} · y {inspector.target.y} · direção {inspector.target.direction} · {
                                inspector.target.visible ? 'visível' : 'oculto'
                            }
                        </code>}
                        {inspector && inspector.variables.map(variable => (
                            <div key={`${variable.ownerId}:${variable.id}`}>
                                <strong>{variable.name}</strong>
                                <span>{variable.ownerName}</span>
                                <code>{JSON.stringify(variable.value)}</code>
                            </div>
                        ))}
                    </section>
                    <section>
                        <h3>Pilha de chamadas</h3>
                        {selectedThread && selectedThread.callStack.map((frame, index) => (
                            <button key={`${frame.blockId}:${index}`} type="button" onClick={() => frame.line && this.openLocation({
                                targetId: selectedThread.targetId,
                                line: frame.line
                            })}>
                                <code>{frame.opcode || frame.blockId}</code>
                                <span>{frame.line ? `L${frame.line}` : 'sem fonte'}</span>
                            </button>
                        ))}
                    </section>
                    <section>
                        <h3>Watch</h3>
                        <form onSubmit={event => this.addWatch(event)}>
                            <input
                                aria-label="Nova expressão watch"
                                placeholder="score * 2"
                                value={this.state.watchInput}
                                onChange={event => this.setState({watchInput: event.target.value})}
                            />
                            <button type="submit">Adicionar</button>
                        </form>
                        {watches.map(watch => (
                            <div key={watch.expression}>
                                <strong>{watch.expression}</strong>
                                <code>{watch.success ? JSON.stringify(watch.value) : watch.error}</code>
                                <button type="button" aria-label={`Remover watch ${watch.expression}`} onClick={() => this.setState(state => ({
                                    watches: state.watches.filter(item => item !== watch.expression)
                                }))}>×</button>
                            </div>
                        ))}
                    </section>
                </div>
                </div>
                {snapshot.runtimeErrors.slice(0, 3).map(error => (
                    <details className={styles.runtimeError} key={`${error.timestamp}:${error.blockId}`}>
                        <summary>Runtime {error.targetName}{error.line ? ` L${error.line}` : ''}: {error.message}</summary>
                        {error.stack && <pre>{error.stack}</pre>}
                        {error.callStack && error.callStack.length > 0 && <code>{error.callStack.map(frame =>
                            `${frame.line ? `L${frame.line}` : frame.blockId}`
                        ).join(' ← ')}</code>}
                    </details>
                ))}
            </div>
        );
    }

    renderExtensionCatalog () {
        const entries = this.state.extensionPalette.filter(entry => entry.kind !== 'separator');
        return (
            <div className={styles.extensionCatalog}>
                {entries.length === 0 && <span className={styles.noDiagnostics}>Nenhuma extensão carregada.</span>}
                {entries.map((entry, index) => (
                    <div className={styles.extensionEntry} key={`${entry.canonicalName}:${index}`}>
                        <span className={styles.extensionKind}>{entry.kind}</span>
                        <code>{entry.canonicalName}</code>
                        {entry.text && <span>{entry.text}</span>}
                        {entry.kind === 'xml' && entry.xml && <code className={styles.extensionXml}>{entry.xml}</code>}
                        {entry.kind === 'xml' && entry.xml && (
                            <button
                                type="button"
                                onClick={() => this.handleInsertExtensionXml(entry)}
                            >Inserir blocos</button>
                        )}
                        {entry.kind === 'button' && entry.actionId && (
                            <button
                                type="button"
                                onClick={() => this.props.vm.handleExtensionButtonPress(entry.actionId)}
                            >Executar ação</button>
                        )}
                    </div>
                ))}
            </div>
        );
    }

    render () {
        const targetLabel = this.state.isStage ? 'Palco' : 'Ator';
        const target = this.getTarget();
        const activeLines = this.state.debugSnapshot.activeLinesByTarget[this.props.editingTargetId] || [];
        return (
            <section className={styles.root} aria-label="Editor textual TextWarp">
                <header className={styles.toolbar}>
                    <div className={styles.identity}>
                        <span className={classNames(styles.targetBadge, this.state.isStage && styles.stageBadge)}>{targetLabel}</span>
                        <div>
                            <strong>{this.state.targetName || 'Nenhum alvo'}</strong>
                            <span className={styles.filename}>{this.state.isStage ? 'stage.tw' : `${this.state.targetName || 'actor'}.tw`}</span>
                        </div>
                    </div>
                    <div className={styles.viewTabs}>
                        <button
                            className={this.state.viewMode === 'code' ? styles.activeTab : ''}
                            type="button"
                            onClick={() => this.setViewMode('code')}
                        >Código</button>
                        <button
                            className={this.state.viewMode === 'blocks' ? styles.activeTab : ''}
                            type="button"
                            onClick={() => this.setViewMode('blocks')}
                        >Blocos</button>
                        <button
                            className={this.state.viewMode === 'split' ? styles.activeTab : ''}
                            type="button"
                            onClick={() => this.setViewMode('split')}
                        >Dividido</button>
                        <button
                            className={this.state.viewMode === 'dual' ? styles.activeTab : ''}
                            type="button"
                            onClick={() => this.setViewMode('dual')}
                        >Editor duplo</button>
                        <button
                            className={this.state.viewMode === 'docs' ? styles.activeTab : ''}
                            type="button"
                            onClick={() => this.setState({docsQuery: ''}, () => this.setViewMode('docs'))}
                        >Documentação</button>
                    </div>
                    <div className={styles.actions}>
                        <button
                            className={classNames(styles.toolButton, this.state.sidebarVisible && styles.debugButtonActive)}
                            title="Explorador (Ctrl+Shift+E)"
                            type="button"
                            onClick={() => this.setState(state => ({sidebarVisible: !state.sidebarVisible}))}
                        >Projeto</button>
                        <button className={styles.toolButton} type="button" onClick={() => {
                            if (this.monacoEditor) this.monacoEditor.openCommandPalette();
                        }}>Comandos</button>
                        <button className={styles.toolButton} type="button" onClick={() => this.setState(state => ({
                            templatesOpen: !state.templatesOpen, settingsOpen: false
                        }))}>Modelos</button>
                        <button className={styles.toolButton} type="button" onClick={() => this.setState(state => ({
                            settingsOpen: !state.settingsOpen, templatesOpen: false
                        }))}>Atalhos</button>
                        <button className={styles.toolButton} disabled={!this.state.targetName || this.state.busy} type="button" onClick={this.handleImportBlocks}>Importar blocos</button>
                        <button className={styles.toolButton} disabled={this.state.busy} type="button" onClick={() => this.packageInput && this.packageInput.click()}>Abrir .textwarp</button>
                        <button className={styles.toolButton} disabled={this.state.busy} type="button" onClick={this.handleExportPackage}>Salvar como…</button>
                        <button
                            className={classNames(styles.toolButton, this.state.extensionsOpen && styles.debugButtonActive)}
                            type="button"
                            onClick={() => this.setState(state => ({
                                extensionsOpen: !state.extensionsOpen, debugOpen: false, consoleOpen: false
                            }))}
                        >Extensões</button>
                        <button
                            className={classNames(styles.toolButton, this.state.consoleOpen && styles.debugButtonActive)}
                            type="button"
                            onClick={() => this.setState(state => ({
                                consoleOpen: !state.consoleOpen, debugOpen: false, extensionsOpen: false
                            }))}
                        >Console</button>
                        <button
                            className={classNames(styles.toolButton, this.state.debugOpen && styles.debugButtonActive)}
                            disabled={!this.state.targetName}
                            type="button"
                            onClick={() => this.toggleDebugger()}
                        >Depurar</button>
                        <button className={styles.secondaryButton} disabled={!this.state.targetName} type="button" onClick={this.handleStop}>■ Parar</button>
                        <button className={styles.secondaryButton} disabled={!this.state.targetName} type="button" onClick={this.handleRestart}>↻ Reiniciar</button>
                        <button className={styles.secondaryButton} disabled={!this.state.targetName || this.state.busy} type="button" onClick={this.handleCompile}>Compilar</button>
                        <button className={styles.runButton} disabled={!this.state.targetName || this.state.busy} type="button" onClick={this.handleRun}>▶ Executar</button>
                        <input
                            accept=".textwarp,application/zip"
                            className={styles.hiddenInput}
                            ref={element => { this.packageInput = element; }}
                            type="file"
                            onChange={this.handlePackageFile}
                        />
                    </div>
                </header>
                <nav className={styles.openTabs} aria-label="Scripts abertos">
                    {this.state.openTargetIds.map(targetId => {
                        const module = this.state.workspace.modules.find(item => item.id === targetId);
                        if (!module) return null;
                        return (
                            <div
                                className={targetId === this.props.editingTargetId ? styles.activeFileTab : ''}
                                key={targetId}
                            >
                                <button className={styles.fileTabMain} type="button" onClick={() => this.openTarget(targetId)}>
                                <span>{module.fileName}</span>
                                {targetId === this.props.editingTargetId && this.state.saveState === 'salvando' && <small>●</small>}
                                </button>
                                {this.state.openTargetIds.length > 1 && <button
                                    aria-label={`Fechar ${module.fileName}`}
                                    className={styles.closeFileTab}
                                    type="button"
                                    onClick={event => this.closeTarget(event, targetId)}
                                >×</button>}
                            </div>
                        );
                    })}
                </nav>
                {this.state.templatesOpen && (
                    <div className={styles.quickPanel} role="dialog" aria-label="Modelos TextWarp">
                        <strong>Modelos iniciais</strong>
                        {IDE_TEMPLATES.filter(template => template.scope === (this.state.isStage ? 'stage' : 'actor')).map(template => (
                            <button key={template.id} type="button" onClick={() => this.applyTemplate(template)}>{template.name}</button>
                        ))}
                        <button type="button" onClick={() => this.setState({templatesOpen: false})}>Fechar</button>
                    </div>
                )}
                {this.state.settingsOpen && (
                    <div className={styles.quickPanel} role="dialog" aria-label="Configuração de atalhos TextWarp">
                        <strong>Atalhos do editor</strong>
                        {Object.entries(this.state.shortcuts).map(([name, value]) => (
                            <label key={name}>
                                <span>{name}</span>
                                <input value={value} onChange={event => this.updateShortcut(name, event.target.value)} />
                            </label>
                        ))}
                        <button type="button" onClick={() => {
                            const shortcuts = Object.assign({}, DEFAULT_SHORTCUTS);
                            this.setState({shortcuts});
                            const storage = this.getStorage();
                            try {
                                if (storage) storage.setItem('textwarp.ide.shortcuts', JSON.stringify(shortcuts));
                            } catch (error) {
                                this.setState({status: 'Padrões restaurados somente nesta sessão.', statusKind: 'working'});
                            }
                        }}>Restaurar padrões</button>
                        <button type="button" onClick={() => this.setState({settingsOpen: false})}>Fechar</button>
                    </div>
                )}
                {this.state.visualConflict && (
                    <div className={styles.conflictBanner}>
                        <strong>Conflito entre texto e blocos.</strong>
                        <span>As duas versões têm alterações não aplicadas.</span>
                        <button type="button" onClick={() => this.keepTextChanges()}>Manter texto</button>
                        <button type="button" onClick={() => this.acceptVisualChanges()}>Usar blocos</button>
                    </div>
                )}
                <div className={styles.mainWorkspace}>
                    <IdeSidebar
                        activeFileName={targetFileName(target)}
                        activePanel={this.state.sidebarPanel}
                        activeTargetId={this.props.editingTargetId}
                        history={this.state.history}
                        outline={getOutline(this.state.source)}
                        searchQuery={this.state.searchQuery}
                        searchResults={this.state.searchResults}
                        replaceValue={this.state.replaceValue}
                        visible={this.state.sidebarVisible && this.state.viewMode !== 'docs'}
                        workspace={this.state.workspace}
                        onInsertResource={this.insertResource}
                        onOpenLocation={this.openLocation}
                        onOpenResource={this.openResource}
                        onOpenTarget={this.openTarget}
                        onPanelChange={sidebarPanel => this.setState({sidebarPanel})}
                        onReplaceAll={this.handleReplaceAll}
                        onReplaceValueChange={replaceValue => this.setState({replaceValue})}
                        onRestoreHistory={this.restoreHistory}
                        onSearch={this.handleSearch}
                    />
                <div className={classNames(
                    styles.editorArea,
                    this.state.viewMode === 'split' && styles.splitMode,
                    this.state.viewMode === 'dual' && styles.dualMode
                )}>
                    <div className={classNames(
                        styles.viewPane,
                        styles.codePane,
                        !['code', 'split', 'dual'].includes(this.state.viewMode) && styles.hiddenPane
                    )}>
                        <MonacoEditor
                            activeLines={activeLines}
                            breakpoints={this.state.breakpoints}
                            dark={this.props.guiTheme === 'dark'}
                            diagnostics={this.state.diagnostics}
                            languageContext={this.getLanguageContext(target)}
                            modelKey={this.props.editingTargetId || 'none'}
                            value={this.state.source}
                            visible={this.props.isVisible && ['code', 'split', 'dual'].includes(this.state.viewMode)}
                            onChange={this.handleChange}
                            onCompile={this.handleCompile}
                            onNavigateResource={name => this.navigateResourceByName(name)}
                            onOpenModel={this.openTarget}
                            onReady={editor => { this.monacoEditor = editor; }}
                            onRestart={this.handleRestart}
                            onRun={this.handleRun}
                            onRunSelection={this.handleRunSelection}
                            onStop={this.handleStop}
                            onToggleBreakpoint={this.handleToggleBreakpoint}
                            onWorkspaceModelChange={(targetId, source) => this.handleWorkspaceModelChange(targetId, source)}
                            shortcuts={this.state.shortcuts}
                        />
                    </div>
                    <div className={classNames(
                        styles.viewPane,
                        styles.secondaryCodePane,
                        this.state.viewMode !== 'dual' && styles.hiddenPane
                    )}>
                        <MonacoEditor
                            activeLines={activeLines}
                            breakpoints={this.state.breakpoints}
                            dark={this.props.guiTheme === 'dark'}
                            diagnostics={this.state.diagnostics}
                            languageContext={this.getLanguageContext(target)}
                            modelKey={`${this.props.editingTargetId || 'none'}:secondary`}
                            value={this.state.source}
                            visible={this.props.isVisible && this.state.viewMode === 'dual'}
                            workspaceModels={false}
                            onChange={this.handleChange}
                            onCompile={this.handleCompile}
                            onNavigateResource={name => this.navigateResourceByName(name)}
                            onReady={editor => { this.secondaryMonacoEditor = editor; }}
                            onRestart={this.handleRestart}
                            onRun={this.handleRun}
                            onRunSelection={this.handleRunSelection}
                            onStop={this.handleStop}
                            onToggleBreakpoint={this.handleToggleBreakpoint}
                            shortcuts={this.state.shortcuts}
                        />
                    </div>
                    <div className={classNames(
                        styles.viewPane,
                        styles.blocksPane,
                        !['blocks', 'split'].includes(this.state.viewMode) && styles.hiddenPane
                    )}>
                        <VisualBlocks
                            canUseCloud={this.props.canUseCloud}
                            grow={this.props.grow}
                            isVisible={this.props.isVisible && ['blocks', 'split'].includes(this.state.viewMode)}
                            options={this.props.options}
                            stageSize={this.props.stageSize}
                            theme={this.props.theme}
                            vm={this.props.vm}
                            onOpenCustomExtensionModal={this.props.onOpenCustomExtensionModal}
                        />
                    </div>
                    <div className={classNames(
                        styles.viewPane,
                        styles.documentationPane,
                        this.state.viewMode !== 'docs' && styles.hiddenPane
                    )}>
                        <DocumentationPane
                            extensionCatalog={this.extensionCatalog}
                            extensionPalette={this.state.extensionPalette}
                            initialQuery={this.state.docsQuery}
                        />
                    </div>
                </div>
                </div>
                <aside className={classNames(
                    styles.bottomPanel,
                    (this.state.debugOpen || this.state.consoleOpen) && styles.debugPanelOpen
                )}>
                    <div className={styles.statusRow}>
                        <span className={classNames(styles.statusDot, styles[this.state.statusKind])} />
                        <span aria-live="polite" role="status">{this.state.status}</span>
                        <nav className={styles.panelTabs} aria-label="Painéis inferiores">
                            <button className={!this.state.debugOpen && !this.state.consoleOpen && !this.state.extensionsOpen ? styles.activePanelTab : ''} type="button" onClick={() => this.setState({
                                debugOpen: false, consoleOpen: false, extensionsOpen: false
                            })}>Problemas <small>{this.state.diagnostics.length}</small></button>
                            <button className={this.state.consoleOpen ? styles.activePanelTab : ''} type="button" onClick={() => this.setState({
                                debugOpen: false, consoleOpen: true, extensionsOpen: false
                            })}>Console</button>
                            <button className={this.state.debugOpen ? styles.activePanelTab : ''} type="button" onClick={() => {
                                this.debugController.setEnabled(true);
                                this.setState({debugOpen: true, consoleOpen: false, extensionsOpen: false});
                            }}>Depuração</button>
                        </nav>
                        <span className={styles.languageHelp}>
                            {this.state.saveState === 'salvo' ? '✓ salvo localmente' : '● salvando'} · TextWarp 0.3 · {
                                this.state.extensionSummary.extensionCount
                            } extensão(ões) · {this.state.extensionSummary.blockCount} opcode(s)
                        </span>
                    </div>
                    {this.state.debugOpen ? this.renderDebugger() : this.state.consoleOpen ? this.renderConsole() : this.state.extensionsOpen ?
                        this.renderExtensionCatalog() : <div className={styles.diagnostics}>{this.renderDiagnostics()}</div>}
                </aside>
            </section>
        );
    }
}

TextEditor.propTypes = {
    canUseCloud: PropTypes.bool,
    editingTargetId: PropTypes.string,
    editingTargetName: PropTypes.string,
    grow: PropTypes.number,
    guiTheme: PropTypes.string,
    isVisible: PropTypes.bool,
    onOpenCustomExtensionModal: PropTypes.func,
    onClearSb3FileHandle: PropTypes.func.isRequired,
    onSetProjectUnchanged: PropTypes.func.isRequired,
    options: PropTypes.shape({}),
    projectTitle: PropTypes.string,
    stageSize: PropTypes.string,
    theme: PropTypes.shape({}),
    vm: PropTypes.shape({
        editingTarget: PropTypes.shape({}),
        greenFlag: PropTypes.func.isRequired,
        loadProject: PropTypes.func.isRequired,
        saveProjectSb3: PropTypes.func.isRequired,
        runtime: PropTypes.shape({
            getTargetById: PropTypes.func.isRequired,
            targets: PropTypes.arrayOf(PropTypes.shape({})).isRequired
        }).isRequired
    }).isRequired
};

TextEditor.defaultProps = {
    isVisible: true,
    onOpenCustomExtensionModal: null,
    projectTitle: 'TextWarp Project'
};

const mapStateToProps = state => {
    const editingTargetId = state.scratchGui.targets.editingTarget;
    const targets = state.scratchGui.targets;
    const editingTarget = targets.sprites[editingTargetId] ||
        (targets.stage.id === editingTargetId ? targets.stage : null);
    return {
        editingTargetId,
        editingTargetName: editingTarget ? editingTarget.name : '',
        guiTheme: state.scratchGui.theme.theme.gui
    };
};

const mapDispatchToProps = dispatch => ({
    onClearSb3FileHandle: () => dispatch(setFileHandle(null)),
    onSetProjectUnchanged: () => dispatch(setProjectUnchanged())
});

export default connect(mapStateToProps, mapDispatchToProps)(TextEditor);
