// Isolated source loading for synthetic protocol and lifecycle tests.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const projectRoot = path.resolve(__dirname, '..');
const sdkRequire = Module.createRequire(require.resolve('@scrypted/sdk'));
const ts = sdkRequire('typescript');

// Each check has an isolated module cache. Only relative project imports are
// transpiled; Node builtins are loaded normally unless explicitly replaced.
function createLoader(mocks = {}) {
    const cache = new Map();
    function load(name) {
        const filename = path.join(projectRoot, 'src', `${name}.ts`);
        if (cache.has(filename)) return cache.get(filename).exports;
        const loaded = new Module(filename, module);
        loaded.filename = filename;
        loaded.paths = Module._nodeModulePaths(path.dirname(filename));
        cache.set(filename, loaded);
        const originalRequire = loaded.require.bind(loaded);
        loaded.require = id => {
            if (Object.hasOwn(mocks, id)) return mocks[id];
            if (id.startsWith('./') || id.startsWith('../')) {
                const target = path.resolve(path.dirname(filename), id);
                return load(path.relative(path.join(projectRoot, 'src'), target));
            }
            return originalRequire(id);
        };
        const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                esModuleInterop: true,
            },
        }).outputText;
        loaded._compile(compiled, filename);
        return loaded.exports;
    }
    return load;
}

exports.createLoader = createLoader;
