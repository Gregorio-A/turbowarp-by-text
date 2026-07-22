'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('@turbowarp/jszip');

const {
    FORMAT_NAME,
    packTextwarp,
    restoreExtensionDependencies,
    unpackTextwarp
} = require('../../src-renderer-webpack/editor/text/textwarp-package');

test('packs editable sources, resources, manifest and compiled SB3 separately', async () => {
    const sb3 = new JSZip();
    sb3.file('project.json', JSON.stringify({targets: [], monitors: [], extensions: [], meta: {semver: '3.0.0'}}));
    sb3.file('asset.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const projectData = await sb3.generateAsync({type: 'uint8array'});
    const packageBytes = await packTextwarp({
        projectData,
        modules: [
            {moduleId: 'stage-module', name: 'Stage', isStage: true, sourceText: 'stage\non green_flag:\n    wait(0)'},
            {moduleId: 'player-module', name: 'Player', isStage: false, sourceText: 'actor Player\non green_flag:\n    move(10)'}
        ],
        extensions: [{id: 'physics', url: 'https://example.com/physics.js'}],
        metadata: {name: 'Game', createdAt: '2026-07-19T00:00:00.000Z'}
    });
    const archive = await JSZip.loadAsync(packageBytes);
    assert.ok(archive.file('manifest.json'));
    assert.ok(archive.file('compiled/project.sb3'));
    assert.ok(archive.file('project/project.json'));
    assert.ok(archive.file('assets/asset.svg'));
    assert.ok(archive.file('extensions/lock.json'));

    const unpacked = await unpackTextwarp(packageBytes);
    assert.equal(unpacked.manifest.format, FORMAT_NAME);
    assert.equal(unpacked.manifest.name, 'Game');
    assert.equal(unpacked.modules.length, 2);
    assert.equal(unpacked.modules.find(module => module.isStage).sourceText.startsWith('stage'), true);
    assert.deepEqual(unpacked.extensions, [{id: 'physics', url: 'https://example.com/physics.js'}]);
    const restoredSb3 = await JSZip.loadAsync(unpacked.projectData);
    assert.ok(restoredSb3.file('project.json'));
    assert.ok(restoredSb3.file('asset.svg'));
});

test('rejects ZIP files that are not TextWarp projects', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'not a project');
    const data = await zip.generateAsync({type: 'uint8array'});
    await assert.rejects(() => unpackTextwarp(data), /manifest\.json/);
});

test('restores locked extension dependencies before a project is compiled', async () => {
    const loaded = new Set(['pen']);
    const requested = [];
    const manager = {
        isExtensionLoaded: id => loaded.has(id),
        isBuiltinExtension: id => id === 'music',
        async loadExtensionURL (locator) {
            requested.push(locator);
            loaded.add(locator === 'music' ? 'music' : 'physics');
        }
    };
    const permissions = [];
    const vm = {
        extensionManager: manager,
        securityManager: {
            async canLoadExtensionFromProject (url) {
                permissions.push(url);
                return true;
            }
        }
    };
    const restored = await restoreExtensionDependencies(vm, [
        {id: 'pen', url: null},
        {id: 'music', url: null},
        {id: 'physics', url: 'https://example.com/physics.js'}
    ]);
    assert.deepEqual(restored.alreadyLoaded, ['pen']);
    assert.deepEqual(restored.loaded, ['music', 'physics']);
    assert.deepEqual(requested, ['music', 'https://example.com/physics.js']);
    assert.deepEqual(permissions, ['https://example.com/physics.js']);
});

test('rejects a missing locked URL instead of silently keeping third-party blocks inert', async () => {
    const vm = {
        extensionManager: {
            isExtensionLoaded: () => false,
            isBuiltinExtension: () => false
        }
    };
    await assert.rejects(
        () => restoreExtensionDependencies(vm, [{id: 'physics', url: null}]),
        /não contém sua URL/
    );
});

test('rejects a locked extension when project loading permission is denied', async () => {
    let loaded = false;
    const vm = {
        extensionManager: {
            isExtensionLoaded: () => false,
            isBuiltinExtension: () => false,
            async loadExtensionURL () { loaded = true; }
        },
        securityManager: {
            async canLoadExtensionFromProject () { return false; }
        }
    };
    await assert.rejects(
        () => restoreExtensionDependencies(vm, [{id: 'physics', url: 'https://example.com/physics.js'}]),
        /Permissão negada/
    );
    assert.equal(loaded, false);
});
