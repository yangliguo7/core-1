// @ts-check
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import replace from '@rollup/plugin-replace'
import pico from 'picocolors'
import polyfillNode from '@rolldown/plugin-node-polyfills'
import { entries } from './scripts/aliases.js'
import { inlineEnums } from './scripts/inline-enums.js'
import { minify as minifySwc } from '@swc/core'

if (!process.env.TARGET) {
  process.env.TARGET = 'vue'
  // throw new Error('TARGET package must be specified via --environment flag.')
}

const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))

const masterVersion = require('./package.json').version
const consolidatePkg = require('@vue/consolidate/package.json')

const packagesDir = path.resolve(__dirname, 'packages')
const packageDir = path.resolve(packagesDir, process.env.TARGET)

const resolve = (/** @type {string} */ p) => path.resolve(packageDir, p)
const pkg = require(resolve(`package.json`))
const packageOptions = pkg.buildOptions || {}
const name = packageOptions.filename || path.basename(packageDir)

const [enumPlugin, enumDefines] = inlineEnums()

/** @typedef {'cjs' | 'esm-bundler' | 'global' | 'global-runtime' | 'esm-browser' | 'esm-bundler-runtime' | 'esm-browser-runtime'} PackageFormat */
// /** @typedef {'cjs' | 'esm-bundler' | 'esm-browser' | 'esm-bundler-runtime' | 'esm-browser-runtime'} PackageFormat */

/** @type {Record<PackageFormat, import('rolldown').OutputOptions>} */
const outputConfigs = {
  'esm-bundler': {
    entryFileNames: `${name}.esm-bundler.js`,
    format: 'es',
  },
  'esm-browser': {
    entryFileNames: `${name}.esm-browser.js`,
    format: 'es',
  },
  cjs: {
    entryFileNames: `${name}.cjs.js`,
    format: 'cjs',
  },
  global: {
    entryFileNames: `${name}.global.js`,
    format: 'iife',
  },
  // runtime-only builds, for main "vue" package only
  'esm-bundler-runtime': {
    entryFileNames: `${name}.runtime.esm-bundler.js`,
    format: 'es',
  },
  'esm-browser-runtime': {
    entryFileNames: `${name}.runtime.esm-browser.js`,
    format: 'es',
  },
  'global-runtime': {
    entryFileNames: `${name}.runtime.global.js`,
    format: 'iife',
  },
}

/** @type {ReadonlyArray<PackageFormat>} */
const defaultFormats = ['esm-bundler', 'cjs']
/** @type {ReadonlyArray<PackageFormat>} */
const inlineFormats = /** @type {any} */ (
  process.env.FORMATS && process.env.FORMATS.split(',')
)
/** @type {ReadonlyArray<PackageFormat>} */
const packageFormats = (
  inlineFormats ||
  packageOptions.formats ||
  defaultFormats
).filter(format => outputConfigs[format])

const packageConfigs = process.env.PROD_ONLY
  ? []
  : packageFormats.map(format => createConfig(format, outputConfigs[format]))

if (process.env.NODE_ENV === 'production') {
  packageFormats.forEach(format => {
    if (packageOptions.prod === false) {
      return
    }
    if (format === 'cjs') {
      packageConfigs.push(createProductionConfig(format))
    }
    if (/^(global|esm-browser)(-runtime)?/.test(format)) {
      packageConfigs.push(createMinifiedConfig(format))
    }
  })
}

export default packageConfigs

/**
 *
 * @param {PackageFormat} format
 * @param {import('rolldown').OutputOptions} output
 * @param {import('rolldown').Plugin[]} plugins
 * @returns {import('rolldown').RolldownOptions}
 */
function createConfig(format, output, plugins = []) {
  if (!output) {
    console.error(pico.yellow(`invalid format: "${format}"`))
    process.exit(1)
  }

  output.dir = resolve('dist')

  const isProductionBuild =
    process.env.__DEV__ === 'false' ||
    /\.prod\.js$/.test(output.entryFileNames || '')
  const isBundlerESMBuild = /esm-bundler/.test(format)
  const isBrowserESMBuild = /esm-browser/.test(format)
  const isServerRenderer = name === 'server-renderer'
  const isCJSBuild = format === 'cjs'
  const isGlobalBuild = /global/.test(format)
  const isCompatPackage =
    pkg.name === '@vue/compat' || pkg.name === '@vue/compat-canary'
  const isCompatBuild = !!packageOptions.compat
  const isBrowserBuild =
    (isGlobalBuild || isBrowserESMBuild || isBundlerESMBuild) &&
    !packageOptions.enableNonBrowserBranches

  output.banner = `/**
  * ${pkg.name} v${masterVersion}
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **/`

  output.exports = isCompatPackage ? 'auto' : 'named'
  if (isCJSBuild) {
    output.esModule = true
  }
  output.sourcemap = !!process.env.SOURCE_MAP

  // @ts-expect-error Not supported yet
  output.externalLiveBindings = false

  // https://github.com/rollup/rollup/pull/5380
  // @ts-expect-error Not supported yet
  output.reexportProtoFromExternal = false

  if (isGlobalBuild) {
    output.name = packageOptions.name
  }

  let entryFile = /runtime$/.test(format) ? `src/runtime.ts` : `src/index.ts`

  // the compat build needs both default AND named exports. This will cause
  // Rollup to complain for non-ESM targets, so we use separate entries for
  // esm vs. non-esm builds.
  if (isCompatPackage && (isBrowserESMBuild || isBundlerESMBuild)) {
    entryFile = /runtime$/.test(format)
      ? `src/esm-runtime.ts`
      : `src/esm-index.ts`
  }

  function resolveDefine() {
    /** @type {Record<string, string>} */
    const replacements = {
      __COMMIT__: `"${process.env.COMMIT}"`,
      __VERSION__: `"${masterVersion}"`,
      // this is only used during Vue's internal tests
      __TEST__: `false`,
      // If the build is expected to run directly in the browser (global / esm builds)
      __BROWSER__: String(isBrowserBuild),
      __GLOBAL__: String(isGlobalBuild),
      __ESM_BUNDLER__: String(isBundlerESMBuild),
      __ESM_BROWSER__: String(isBrowserESMBuild),
      // is targeting Node (SSR)?
      __CJS__: String(isCJSBuild),
      // need SSR-specific branches?
      __SSR__: String(isCJSBuild || isBundlerESMBuild || isServerRenderer),

      // 2.x compat build
      __COMPAT__: String(isCompatBuild),

      // feature flags
      __FEATURE_SUSPENSE__: `true`,
      __FEATURE_OPTIONS_API__: isBundlerESMBuild
        ? `__VUE_OPTIONS_API__`
        : `true`,
      __FEATURE_PROD_DEVTOOLS__: isBundlerESMBuild
        ? `__VUE_PROD_DEVTOOLS__`
        : `false`,
      __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__: isBundlerESMBuild
        ? `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`
        : `false`,
    }

    if (!isBundlerESMBuild) {
      // hard coded dev/prod builds
      replacements.__DEV__ = String(!isProductionBuild)
    }

    // allow inline overrides like
    //__RUNTIME_COMPILE__=true pnpm build runtime-core
    Object.keys(replacements).forEach(key => {
      if (key in process.env) {
        const value = process.env[key]
        assert(typeof value === 'string')
        replacements[key] = value
      }
    })

    // TODO remove after https://github.com/rolldown/rolldown/pull/1952 is released
    replacements['process.env.NODE_ENV'] = 'process.env.NODE_ENV'

    return replacements
  }

  // esbuild define is a bit strict and only allows literal json or identifiers
  // so we still need replace plugin in some cases
  /**
   * @returns {import('rolldown').Plugin[]}
   */
  function resolveReplace() {
    /** @type {Record<string, string>} */
    const replacements = {}

    if (isProductionBuild && isBrowserBuild) {
      Object.assign(replacements, {
        'context.onError(': `/*#__PURE__*/ context.onError(`,
        'emitError(': `/*#__PURE__*/ emitError(`,
        'createCompilerError(': `/*#__PURE__*/ createCompilerError(`,
        'createDOMCompilerError(': `/*#__PURE__*/ createDOMCompilerError(`,
      })
    }

    if (isBundlerESMBuild) {
      Object.assign(replacements, {
        // preserve to be handled by bundlers
        __DEV__: `!!(process.env.NODE_ENV !== 'production')`,
      })
    }

    // for compiler-sfc browser build inlined deps
    if (isBrowserESMBuild) {
      Object.assign(replacements, {
        'process.env': '({})',
        'process.platform': '""',
        'process.stdout': 'null',
      })
    }

    if (Object.keys(replacements).length) {
      // @ts-expect-error Rollup plugin type still incompatible
      return [replace({ values: replacements, preventAssignment: true })]
    } else {
      return []
    }
  }

  function resolveExternal() {
    const treeShakenDeps = [
      'source-map-js',
      '@babel/parser',
      'estree-walker',
      'entities/lib/decode.js',
    ]

    // we are bundling forked consolidate.js in compiler-sfc which dynamically
    // requires a ton of template engines which should be ignored.
    let cjsIgnores = []
    if (
      pkg.name === '@vue/compiler-sfc' ||
      pkg.name === '@vue/compiler-sfc-canary'
    ) {
      cjsIgnores = [
        ...Object.keys(consolidatePkg.devDependencies),
        'vm',
        'crypto',
        'react-dom/server',
        'teacup/lib/express',
        'arc-templates/dist/es5',
        'then-pug',
        'then-jade',
      ]
    }

    if (isGlobalBuild || isBrowserESMBuild || isCompatPackage) {
      if (!packageOptions.enableNonBrowserBranches) {
        // normal browser builds - non-browser only imports are tree-shaken,
        // they are only listed here to suppress warnings.
        return treeShakenDeps
      } else {
        return cjsIgnores
      }
    } else {
      // Node / esm-bundler builds.
      // externalize all direct deps unless it's the compat build.
      return [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
        // for @vue/compiler-sfc / server-renderer
        ...['path', 'url', 'stream'],
        // somehow these throw warnings for runtime-* package builds
        ...treeShakenDeps,
        ...cjsIgnores,
      ]
    }
  }

  function resolveNodePlugins() {
    const nodePlugins =
      (format === 'cjs' && Object.keys(pkg.devDependencies || {}).length) ||
      packageOptions.enableNonBrowserBranches
        ? [...(format === 'cjs' ? [] : [polyfillNode()])]
        : []
    return nodePlugins
  }

  return {
    input: resolve(entryFile),
    // Global and Browser ESM builds inlines everything so that they can be
    // used alone.
    external: resolveExternal(),
    define: { ...enumDefines, ...resolveDefine() },
    platform: format === 'cjs' ? 'node' : 'browser',
    resolve: {
      alias: entries,
    },
    plugins: [
      // @ts-expect-error rollup's Plugin type incompatible w/ rolldown's vendored Plugin type
      enumPlugin,
      ...resolveReplace(),
      ...resolveNodePlugins(),
      ...plugins,
    ],
    output,
    onwarn: (msg, warn) => {
      if (msg.code !== 'CIRCULAR_DEPENDENCY') {
        warn(msg)
      }
    },
    treeshake: {
      // https://github.com/rolldown/rolldown/issues/1917
      moduleSideEffects: false,
    },
  }
}

function createProductionConfig(/** @type {PackageFormat} */ format) {
  return createConfig(format, {
    entryFileNames: `${name}.${format}.prod.js`,
    format: outputConfigs[format].format,
  })
}

function createMinifiedConfig(/** @type {PackageFormat} */ format) {
  return createConfig(
    format,
    {
      entryFileNames: outputConfigs[format].entryFileNames?.replace(
        /\.js$/,
        '.prod.js',
      ),
      format: outputConfigs[format].format,
      // minify: true,
    },
    [
      {
        name: 'swc-minify',
        async renderChunk(
          contents,
          _,
          {
            format,
            sourcemap,
            // @ts-expect-error not supported yet
            sourcemapExcludeSources,
          },
        ) {
          const { code, map } = await minifySwc(contents, {
            module: format === 'es',
            compress: {
              ecma: 2016,
              pure_getters: true,
            },
            safari10: true,
            mangle: true,
            sourceMap: !!sourcemap,
            inlineSourcesContent: !sourcemapExcludeSources,
          })
          return { code, map: map || null }
        },
      },
    ],
  )
}
