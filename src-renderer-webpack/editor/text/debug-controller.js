'use strict';

const {readSourceRecord} = require('./vm-adapter');

const controllers = new WeakMap();

class TextWarpDebugController {
    constructor (vm) {
        this.vm = vm;
        this.runtime = vm.runtime;
        this.enabled = false;
        this.pauseAllRequested = false;
        this.breakpoints = new Map();
        this.paused = new Map();
        this.compiledPaused = new Map();
        this.compiledStepOnce = new Set();
        this.pauseAllExempt = new Set();
        this.stepAfterBlock = new Map();
        this.activeByThread = new Map();
        this.runtimeErrors = [];
        this.listeners = new Set();
        this.originalCompilerEnabled = null;
        this.interpreterRequired = false;
        this.notificationTimer = null;
        this.pollTimer = null;
        this.extensionListener = () => this.instrumentPrimitives();
        if (this.runtime && typeof this.runtime.on === 'function') {
            this.runtime.on('EXTENSION_ADDED', this.extensionListener);
            this.runtime.on('BLOCKSINFO_UPDATE', this.extensionListener);
            this.runtime.on('PROJECT_STOP_ALL', () => this.clearPaused(false));
        }
        this.instrumentThreadCreation();
        this.instrumentThreadStepping();
        this.instrumentPrimitives();
    }

    instrumentThreadCreation () {
        if (!this.runtime || typeof this.runtime._pushThread !== 'function') return;
        const current = this.runtime._pushThread;
        if (current.__textwarpController === this) return;
        const original = current.__textwarpOriginal || current;
        const controller = this;
        const wrapped = function (id, target, options) {
            const targetBreakpoints = target && controller.breakpoints.get(target.id);
            const useInterpreter = Boolean(controller.enabled && targetBreakpoints && targetBreakpoints.size);
            if (!useInterpreter || !this.compilerOptions || !this.compilerOptions.enabled) {
                return original.call(this, id, target, options);
            }
            // _pushThread checks this flag synchronously. Temporarily disabling it
            // keeps only this target's new thread out of the compiler; other
            // actors and the global compiler setting remain untouched.
            this.compilerOptions.enabled = false;
            try {
                return original.call(this, id, target, options);
            } finally {
                this.compilerOptions.enabled = true;
            }
        };
        wrapped.__textwarpOriginal = original;
        wrapped.__textwarpController = this;
        this.runtime._pushThread = wrapped;
    }

    instrumentThreadStepping () {
        const sequencer = this.runtime && this.runtime.sequencer;
        if (!sequencer || typeof sequencer.stepThread !== 'function') return;
        const current = sequencer.stepThread;
        if (current.__textwarpController === this) return;
        const original = current.__textwarpOriginal || current;
        const controller = this;
        const wrapped = function (thread) {
            if (!controller.enabled || !thread || !thread.isCompiled) return original.call(this, thread);
            if (controller.compiledStepOnce.has(thread)) {
                controller.compiledStepOnce.delete(thread);
                return original.call(this, thread);
            }
            if (controller.pauseAllRequested && !controller.pauseAllExempt.has(thread)) {
                controller.pauseCompiledThread(thread);
                return;
            }
            return original.call(this, thread);
        };
        wrapped.__textwarpOriginal = original;
        wrapped.__textwarpController = this;
        sequencer.stepThread = wrapped;
    }

    pauseCompiledThread (thread) {
        if (this.compiledPaused.has(thread)) return;
        const blockId = thread.blockGlowInFrame || (thread.peekStack && thread.peekStack());
        const active = this.activeByThread.get(thread) || {};
        const location = this.sourceLocation(thread, blockId) || active.location;
        const threadId = thread.getId ? thread.getId() : active.threadId || String(this.compiledPaused.size + 1);
        this.activeByThread.set(thread, {threadId, blockId, location, target: thread.target});
        this.compiledPaused.set(thread, {
            threadId,
            blockId,
            location,
            target: thread.target,
            status: thread.status
        });
        // scratch-vm reserves status 1 for a suspended thread. Unlike restarting
        // the script in the interpreter, this preserves the compiled generator
        // and all of its local execution state until it is resumed.
        thread.status = 1;
        this.notify();
    }

    restoreCompiledThread (thread) {
        const state = this.compiledPaused.get(thread);
        if (!state) return false;
        this.compiledPaused.delete(thread);
        if (thread.status === 1) thread.status = state.status === 1 ? 0 : state.status;
        return true;
    }

    instrumentPrimitives () {
        if (!this.runtime || !this.runtime._primitives) return;
        Object.keys(this.runtime._primitives).forEach(opcode => {
            const primitive = this.runtime._primitives[opcode];
            if (typeof primitive !== 'function' || primitive.__textwarpController === this) return;
            const original = primitive.__textwarpOriginal || primitive;
            const controller = this;
            const wrapped = function (args, util) {
                if (!controller.enabled || !util || !util.thread) return original(args, util);
                return controller.beforePrimitive(opcode, original, args, util);
            };
            wrapped.__textwarpOriginal = original;
            wrapped.__textwarpController = this;
            this.runtime._primitives[opcode] = wrapped;
        });
    }

    setEnabled (enabled) {
        enabled = Boolean(enabled);
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        if (enabled) {
            this.instrumentThreadCreation();
            this.instrumentThreadStepping();
            this.instrumentPrimitives();
            this.pollTimer = setInterval(() => this.notify(), 80);
            this.updateExecutionMode();
        } else {
            this.clearPaused(true);
            this.pauseAllRequested = false;
            this.stepAfterBlock.clear();
            this.activeByThread.clear();
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            this.restoreCompilerMode();
        }
        this.notify();
    }

    hasBreakpoints () {
        return Array.from(this.breakpoints.values()).some(lines => lines.size > 0);
    }

    updateExecutionMode () {
        const selectiveInterpreter = Boolean(this.enabled && this.hasBreakpoints());
        const requiresGlobalInterpreter = Boolean(this.enabled && this.pauseAllRequested);
        this.interpreterRequired = selectiveInterpreter || requiresGlobalInterpreter;
        if (requiresGlobalInterpreter) {
            if (this.originalCompilerEnabled === null) {
                this.originalCompilerEnabled = Boolean(this.runtime.compilerOptions && this.runtime.compilerOptions.enabled);
                if (typeof this.runtime.setCompilerOptions === 'function') this.runtime.setCompilerOptions({enabled: false});
            }
        } else {
            this.restoreCompilerMode();
        }
    }

    restoreCompilerMode () {
        if (
            this.originalCompilerEnabled !== null &&
            Boolean(this.runtime.compilerOptions && this.runtime.compilerOptions.enabled) !== this.originalCompilerEnabled &&
            typeof this.runtime.setCompilerOptions === 'function'
        ) {
            this.runtime.setCompilerOptions({enabled: this.originalCompilerEnabled});
        }
        this.originalCompilerEnabled = null;
    }

    setBreakpoints (target, lines) {
        if (!target) return;
        const normalized = new Set(lines || []);
        if (normalized.size) this.breakpoints.set(target.id, normalized);
        else this.breakpoints.delete(target.id);
        if (this.enabled) this.updateExecutionMode();
        this.notify();
    }

    sourceLocation (thread, blockId) {
        if (!thread || !thread.target || !blockId) return null;
        const record = readSourceRecord(thread.target);
        const location = record && record.sourceMap && record.sourceMap[blockId];
        return location ? Object.assign({targetId: thread.target.id}, location) : null;
    }

    shouldPause (thread, blockId, block, location) {
        if (!location || block && block.shadow || this.paused.has(thread)) return false;
        const steppingFrom = this.stepAfterBlock.get(thread);
        if (steppingFrom && steppingFrom !== blockId) {
            this.stepAfterBlock.delete(thread);
            return true;
        }
        if (this.pauseAllRequested && !this.pauseAllExempt.has(thread)) return true;
        const lines = this.breakpoints.get(thread.target.id);
        return Boolean(lines && lines.has(location.startLine));
    }

    beforePrimitive (opcode, original, args, util) {
        const thread = util.thread;
        const blockId = thread.peekStack && thread.peekStack();
        const block = thread.target && thread.target.blocks && thread.target.blocks.getBlock(blockId);
        const location = this.sourceLocation(thread, blockId);
        const threadId = thread.getId ? thread.getId() : String(this.activeByThread.size + 1);
        this.activeByThread.set(thread, {threadId, blockId, opcode, location, target: thread.target});
        this.notify();
        if (!this.shouldPause(thread, blockId, block, location)) return this.invokePrimitive(original, args, util, location);
        return new Promise((resolve, reject) => {
            this.paused.set(thread, {
                threadId,
                blockId,
                opcode,
                location,
                target: thread.target,
                continue: () => {
                    this.paused.delete(thread);
                    try {
                        Promise.resolve(this.invokePrimitive(original, args, util, location)).then(resolve, reject);
                    } catch (error) {
                        reject(error);
                    }
                    this.updateExecutionMode();
                    this.notify();
                }
            });
            this.notify();
        });
    }

    invokePrimitive (original, args, util, location) {
        try {
            const result = original(args, util);
            if (result && typeof result.then === 'function') return result.catch(error => {
                this.captureRuntimeError(error, util.thread, location);
                throw error;
            });
            return result;
        } catch (error) {
            this.captureRuntimeError(error, util.thread, location);
            throw error;
        }
    }

    captureRuntimeError (error, thread, location) {
        this.runtimeErrors.unshift({
            message: error && error.message ? error.message : String(error),
            targetId: thread && thread.target ? thread.target.id : null,
            targetName: thread && thread.target && thread.target.getName ? thread.target.getName() : '',
            line: location ? location.startLine : null,
            blockId: location ? location.blockId : null,
            timestamp: Date.now()
        });
        this.runtimeErrors.length = Math.min(this.runtimeErrors.length, 20);
        this.notify();
    }

    pauseAll () {
        this.pauseAllExempt.clear();
        this.pauseAllRequested = true;
        this.setEnabled(true);
        this.updateExecutionMode();
        this.notify();
    }

    resumeAll () {
        this.pauseAllRequested = false;
        this.pauseAllExempt.clear();
        Array.from(this.paused.values()).forEach(state => state.continue());
        Array.from(this.compiledPaused.keys()).forEach(thread => this.restoreCompiledThread(thread));
        this.compiledStepOnce.clear();
        this.updateExecutionMode();
        this.notify();
    }

    resumeThread (threadId) {
        const entry = Array.from(this.paused.entries()).find(([, state]) => state.threadId === threadId);
        if (entry) {
            this.pauseAllExempt.add(entry[0]);
            entry[1].continue();
            return;
        }
        const compiled = Array.from(this.compiledPaused.entries()).find(([, state]) => state.threadId === threadId);
        if (compiled) {
            this.pauseAllExempt.add(compiled[0]);
            this.restoreCompiledThread(compiled[0]);
            this.notify();
        }
    }

    stepThread (threadId) {
        const entry = Array.from(this.paused.entries()).find(([, state]) => state.threadId === threadId);
        if (entry) {
            this.pauseAllExempt.delete(entry[0]);
            this.stepAfterBlock.set(entry[0], entry[1].blockId);
            this.updateExecutionMode();
            entry[1].continue();
            return;
        }
        const compiled = Array.from(this.compiledPaused.entries()).find(([, state]) => state.threadId === threadId);
        if (compiled) {
            this.pauseAllExempt.delete(compiled[0]);
            this.compiledStepOnce.add(compiled[0]);
            this.restoreCompiledThread(compiled[0]);
            this.notify();
        }
    }

    clearPaused (resume) {
        const states = Array.from(this.paused.values());
        const compiledThreads = Array.from(this.compiledPaused.keys());
        this.paused.clear();
        if (resume) states.forEach(state => state.continue());
        if (resume) compiledThreads.forEach(thread => this.restoreCompiledThread(thread));
        else this.compiledPaused.clear();
        this.compiledStepOnce.clear();
        this.pauseAllExempt.clear();
        if (this.enabled) this.updateExecutionMode();
        this.notify();
    }

    snapshot () {
        const runtimeThreads = new Set(this.runtime && this.runtime.threads || []);
        Array.from(this.activeByThread.keys()).forEach(thread => {
            if (!runtimeThreads.has(thread) && !this.paused.has(thread) && !this.compiledPaused.has(thread)) {
                this.activeByThread.delete(thread);
            }
        });
        Array.from(this.compiledPaused.keys()).forEach(thread => {
            if (!runtimeThreads.has(thread)) this.compiledPaused.delete(thread);
        });
        const allThreads = new Set([...runtimeThreads, ...this.paused.keys(), ...this.compiledPaused.keys()]);
        const threads = Array.from(allThreads).map(thread => {
            const active = this.activeByThread.get(thread) || {};
            const interpretedPause = this.paused.get(thread);
            const compiledPause = this.compiledPaused.get(thread);
            const paused = interpretedPause || compiledPause;
            const blockId = paused ? paused.blockId : (thread.peekStack && thread.peekStack()) || active.blockId;
            const location = paused ? paused.location : this.sourceLocation(thread, blockId) || active.location;
            return {
                id: paused ? paused.threadId : (thread.getId ? thread.getId() : active.threadId),
                targetId: thread.target && thread.target.id,
                targetName: thread.target && thread.target.getName ? thread.target.getName() : '',
                blockId,
                line: location ? location.startLine : null,
                paused: Boolean(paused),
                executionMode: thread.isCompiled ? 'jit' : 'interpreter',
                stepGranularity: compiledPause ? 'frame' : 'block',
                status: Boolean(paused) ? 'paused' : 'running'
            };
        });
        const activeLinesByTarget = {};
        threads.forEach(thread => {
            if (!thread.targetId || !thread.line) return;
            if (!activeLinesByTarget[thread.targetId]) activeLinesByTarget[thread.targetId] = [];
            if (!activeLinesByTarget[thread.targetId].includes(thread.line)) activeLinesByTarget[thread.targetId].push(thread.line);
        });
        return {
            enabled: this.enabled,
            interpreterRequired: this.interpreterRequired,
            selectiveInterpreter: Boolean(this.enabled && this.hasBreakpoints() && !this.pauseAllRequested),
            jitEnabled: Boolean(this.runtime && this.runtime.compilerOptions && this.runtime.compilerOptions.enabled),
            pauseAllRequested: this.pauseAllRequested,
            threads,
            activeLinesByTarget,
            runtimeErrors: this.runtimeErrors.slice()
        };
    }

    subscribe (listener) {
        this.listeners.add(listener);
        listener(this.snapshot());
        return () => this.listeners.delete(listener);
    }

    notify () {
        if (this.notificationTimer !== null) return;
        this.notificationTimer = setTimeout(() => {
            this.notificationTimer = null;
            const snapshot = this.snapshot();
            this.listeners.forEach(listener => listener(snapshot));
        }, 16);
    }
}

const getDebugController = vm => {
    if (!controllers.has(vm)) controllers.set(vm, new TextWarpDebugController(vm));
    return controllers.get(vm);
};

module.exports = {
    TextWarpDebugController,
    getDebugController
};
