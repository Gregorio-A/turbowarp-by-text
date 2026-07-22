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
import {decompileTarget} from './decompiler';
import {buildExtensionInventory, summarizeExtensionCatalog} from './extension-catalog';
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
import styles from './text-editor.css';

const AUTO_COMPILE_DELAY = 300;

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
            blockRefresh: 0,
            breakpoints: [],
            debugOpen: false,
            extensionsOpen: false,
            debugSnapshot: {enabled: false, threads: [], activeLinesByTarget: {}, runtimeErrors: []},
            extensionSummary: {extensionCount: 0, blockCount: 0, extensions: []},
            extensionPalette: [],
            visualConflict: null,
            busy: false
        };
        this.compileTimer = null;
        this.debugController = null;
        this.unsubscribeDebugger = null;
        this.extensionCatalog = {};
        this.lastAppliedSource = '';
        this.lastBlockFingerprint = '';
        this.blockSyncTimer = null;
        this.suppressBlockSyncUntil = 0;
        this.handleProjectLoaded = () => clearTextwarpHandle(`${this.props.projectTitle || 'project'}.textwarp`);
        this.packageInput = null;
        this.handleChange = this.handleChange.bind(this);
        this.handleCompile = this.handleCompile.bind(this);
        this.handleRun = this.handleRun.bind(this);
        this.handleImportBlocks = this.handleImportBlocks.bind(this);
        this.handleExportPackage = this.handleExportPackage.bind(this);
        this.handlePackageFile = this.handlePackageFile.bind(this);
        this.handleToggleBreakpoint = this.handleToggleBreakpoint.bind(this);
        this.handleExtensionsChanged = this.handleExtensionsChanged.bind(this);
        this.handleInsertExtensionXml = this.handleInsertExtensionXml.bind(this);
        this.handleProjectChanged = this.handleProjectChanged.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
    }

    componentDidMount () {
        this._isMounted = true;
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
        if (!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== 's') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.saveTextwarp(Boolean(event.shiftKey));
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
        const source = stored ? stored.source : getTemplate(target);
        const compilation = compileText(source, this.getCompileOptions(target));
        const existingBlocks = target.blocks && target.blocks._blocks ? Object.keys(target.blocks._blocks).length : 0;
        const breakpoints = stored ? stored.breakpoints : [];
        if (this.debugController) this.debugController.setBreakpoints(target, breakpoints);
        this.lastAppliedSource = stored ? stored.source : '';
        this.lastBlockFingerprint = blockFingerprint(target);
        this.setState({
            source,
            diagnostics: compilation.diagnostics,
            status: stored ? 'Fonte carregada do projeto.' : existingBlocks ?
                'Este alvo já tem blocos. Use “Importar blocos” para convertê-los em texto.' :
                'Exemplo inicial — edite ou compile para adicioná-lo ao projeto.',
            statusKind: stored ? 'success' : 'idle',
            targetName: target.getName(),
            isStage: target.isStage,
            breakpoints,
            visualConflict: null,
            blockRefresh: this.state.blockRefresh + 1
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
            statusKind: errors ? 'error' : 'working'
        });
        clearTimeout(this.compileTimer);
        if (compilation.success) {
            const targetId = target.id;
            this.compileTimer = setTimeout(() => {
                if (this.props.editingTargetId === targetId) this.applyCompilation(compilation, target, false);
            }, AUTO_COMPILE_DELAY);
        }
    }

    applyCompilation (compilation, target, run) {
        try {
            this.suppressBlockSyncUntil = Date.now() + 750;
            const record = applyCompilation(this.props.vm, target, compilation);
            this.lastAppliedSource = compilation.source;
            this.lastBlockFingerprint = blockFingerprint(target);
            const apply = record.lastApply || {};
            const changed = (apply.createdUnits || 0) + (apply.updatedUnits || 0);
            this.setState(state => ({
                diagnostics: compilation.diagnostics,
                status: `${record.generatedBlockIds.length} bloco(s) · ${changed} unidade(s) atualizada(s) · ${apply.unchangedUnits || 0} preservada(s).`,
                statusKind: 'success',
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
        this.setState({debugOpen, extensionsOpen: false});
    }

    renderDiagnostics () {
        if (this.state.diagnostics.length === 0) return <span className={styles.noDiagnostics}>Nenhum problema encontrado.</span>;
        return this.state.diagnostics.slice(0, 8).map((item, index) => (
            <div
                className={classNames(styles.diagnostic, styles[item.severity])}
                key={`${item.line}:${item.column}:${item.code}:${index}`}
            >
                <span className={styles.diagnosticLocation}>L{item.line}:{item.column}</span>
                <span>{item.message}</span>
            </div>
        ));
    }

    renderDebugger () {
        const snapshot = this.state.debugSnapshot;
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
                <div className={styles.threadList}>
                    {snapshot.threads.length === 0 && <span className={styles.noDiagnostics}>Nenhuma thread ativa.</span>}
                    {snapshot.threads.map(thread => (
                        <div className={styles.thread} key={thread.id}>
                            <span className={classNames(styles.threadState, thread.paused && styles.threadPaused)}>
                                {thread.paused ? 'pausada' : 'executando'}
                            </span>
                            <strong>{thread.targetName}</strong>
                            <code>
                                {thread.line ? `linha ${thread.line}` : thread.blockId || 'sem linha'} · {
                                    thread.executionMode === 'jit' ? 'JIT' : 'interpretador'
                                }
                            </code>
                            {thread.paused && <>
                                <button type="button" onClick={() => this.debugController.stepThread(thread.id)}>
                                    {thread.stepGranularity === 'frame' ? 'Passo de frame' : 'Passo'}
                                </button>
                                <button type="button" onClick={() => this.debugController.resumeThread(thread.id)}>Continuar</button>
                            </>}
                        </div>
                    ))}
                </div>
                {snapshot.runtimeErrors.slice(0, 3).map(error => (
                    <div className={styles.runtimeError} key={`${error.timestamp}:${error.blockId}`}>
                        Runtime {error.targetName}{error.line ? ` L${error.line}` : ''}: {error.message}
                    </div>
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
                    </div>
                    <div className={styles.actions}>
                        <button className={styles.toolButton} disabled={!this.state.targetName || this.state.busy} type="button" onClick={this.handleImportBlocks}>Importar blocos</button>
                        <button className={styles.toolButton} disabled={this.state.busy} type="button" onClick={() => this.packageInput && this.packageInput.click()}>Abrir .textwarp</button>
                        <button className={styles.toolButton} disabled={this.state.busy} type="button" onClick={this.handleExportPackage}>Salvar como…</button>
                        <button
                            className={classNames(styles.toolButton, this.state.extensionsOpen && styles.debugButtonActive)}
                            type="button"
                            onClick={() => this.setState(state => ({extensionsOpen: !state.extensionsOpen, debugOpen: false}))}
                        >Extensões</button>
                        <button
                            className={classNames(styles.toolButton, this.state.debugOpen && styles.debugButtonActive)}
                            disabled={!this.state.targetName}
                            type="button"
                            onClick={() => this.toggleDebugger()}
                        >Depurar</button>
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
                {this.state.visualConflict && (
                    <div className={styles.conflictBanner}>
                        <strong>Conflito entre texto e blocos.</strong>
                        <span>As duas versões têm alterações não aplicadas.</span>
                        <button type="button" onClick={() => this.keepTextChanges()}>Manter texto</button>
                        <button type="button" onClick={() => this.acceptVisualChanges()}>Usar blocos</button>
                    </div>
                )}
                <div className={classNames(styles.editorArea, this.state.viewMode === 'split' && styles.splitMode)}>
                    <div className={classNames(
                        styles.viewPane,
                        styles.codePane,
                        !['code', 'split'].includes(this.state.viewMode) && styles.hiddenPane
                    )}>
                        <MonacoEditor
                            activeLines={activeLines}
                            breakpoints={this.state.breakpoints}
                            dark={this.props.guiTheme === 'dark'}
                            diagnostics={this.state.diagnostics}
                            modelKey={this.props.editingTargetId || 'none'}
                            value={this.state.source}
                            visible={this.props.isVisible && ['code', 'split'].includes(this.state.viewMode)}
                            onChange={this.handleChange}
                            onToggleBreakpoint={this.handleToggleBreakpoint}
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
                </div>
                <aside className={classNames(styles.bottomPanel, this.state.debugOpen && styles.debugPanelOpen)}>
                    <div className={styles.statusRow}>
                        <span className={classNames(styles.statusDot, styles[this.state.statusKind])} />
                        <span>{this.state.status}</span>
                        <span className={styles.languageHelp}>
                            TextWarp 0.3 · {this.state.extensionSummary.extensionCount} extensão(ões) · {this.state.extensionSummary.blockCount} opcode(s)
                        </span>
                    </div>
                    {this.state.debugOpen ? this.renderDebugger() : this.state.extensionsOpen ?
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
