import { chalk, REG_VUE, VUE_EXT } from '@tarojs/helper'
import { DEFAULT_Components } from '@tarojs/runner-utils'
import { isString } from '@tarojs/shared'
import { capitalize, internalComponents, toCamelCase } from '@tarojs/shared/dist/template'
import { mergeWith } from 'lodash'

import { getLoaderMeta } from './loader-meta'
import { CUSTOM_WRAPPER } from './utils'
import { h5VitePlugin } from './vite.h5'
import { harmonyVitePlugin } from './vite.harmony'
import { miniVitePlugin } from './vite.mini'
import { modifyH5WebpackChain } from './webpack.h5'
import { modifyHarmonyWebpackChain } from './webpack.harmony'
import { modifyMiniWebpackChain } from './webpack.mini'

import type { IPluginContext } from '@tarojs/service'
import type { IComponentConfig } from '@tarojs/taro/types/compile/hooks'
import type { PluginOption } from 'vite'

interface OnParseCreateElementArgs {
  nodeName: string
  componentConfig: IComponentConfig
}

export default (ctx: IPluginContext) => {
  const { framework } = ctx.initialConfig
  if (framework !== 'vue') return

  ctx.modifyWebpackChain(({ chain, data }) => {
    // 通用
    if (process.env.NODE_ENV !== 'production') {
      setAlias(chain)
    }

    customVueChain(chain, data)
    setLoader(chain)

    if (process.env.TARO_PLATFORM === 'web') {
      // H5
      modifyH5WebpackChain(ctx, chain)
    } else if (process.env.TARO_PLATFORM === 'harmony' || process.env.TARO_ENV === 'harmony') {
      // 鸿蒙
      modifyHarmonyWebpackChain(ctx, data)
    } else {
      // 小程序
      modifyMiniWebpackChain(chain, data)
    }
    const { isBuildNativeComp = false } = ctx.runOpts?.options || {}
    const externals: Record<string, string> = {}
    if (isBuildNativeComp) {
      // Note: 该模式不支持 prebundle 优化，不必再处理
      externals.vue = 'vue'
    }

    chain.merge({ externals })
  })

  ctx.modifyViteConfig(({ viteConfig, data }) => {
    viteConfig.plugins.push(viteCommonPlugin())
    if (process.env.TARO_PLATFORM === 'web') {
      // H5
      viteConfig.plugins.push(h5VitePlugin(ctx))
    } else if (process.env.TARO_PLATFORM === 'harmony' || process.env.TARO_ENV === 'harmony') {
      // 鸿蒙
      viteConfig.plugins.push(harmonyVitePlugin(ctx, data?.componentConfig))
    } else {
      // 小程序
      viteConfig.plugins.push(miniVitePlugin(ctx, data?.componentConfig))
    }
  })

  ctx.modifyRunnerOpts(({ opts }) => {
    opts.frameworkExts = VUE_EXT

    if (!opts?.compiler) return

    if (isString(opts.compiler)) {
      opts.compiler = {
        type: opts.compiler
      }
    }

    const { compiler } = opts
    if (compiler.type === 'webpack5') {
      // 提供给 webpack5 依赖预编译收集器的第三方依赖
      const deps = [
        'vue',
        '@tarojs/plugin-framework-vue2/dist/runtime'
      ]
      compiler.prebundle ||= {}
      const prebundleOptions = compiler.prebundle
      prebundleOptions.include ||= []
      prebundleOptions.include = prebundleOptions.include.concat(deps)
      prebundleOptions.exclude ||= []
    }
  })

  ctx.onParseCreateElement(({ nodeName, componentConfig }: OnParseCreateElementArgs) => {
    if (capitalize(toCamelCase(nodeName)) in internalComponents) {
      componentConfig.includes.add(nodeName)
    }
  })
}

function getVueLoaderPath (): string {
  try {
    return require.resolve('vue-loader', {
      paths: [process.cwd()]
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow('找不到 vue-loader，请先安装。'))
    process.exit(1)
  }
}

function customVueChain (chain, data) {
  const vueLoaderPath = getVueLoaderPath()

  // plugin
  const { VueLoaderPlugin } = require(vueLoaderPath)
  chain
    .plugin('vueLoaderPlugin')
    .use(VueLoaderPlugin)

  // loader
  let vueLoaderOption

  if (process.env.TARO_PLATFORM === 'web') {
    // H5
    vueLoaderOption = {
      transformAssetUrls: {
        video: ['src', 'poster'],
        'live-player': 'src',
        audio: 'src',
        source: 'src',
        image: 'src',
        'cover-image': 'src',
        'taro-video': ['src', 'poster'],
        'taro-live-player': 'src',
        'taro-audio': 'src',
        'taro-source': 'src',
        'taro-image': 'src',
        'taro-cover-image': 'src'
      },
      compilerOptions: {
        modules: [{
          preTransformNode (el) {
            if (DEFAULT_Components.has(el.tag)) {
              el.tag = 'taro-' + el.tag
            }
            return el
          }
        }]
      }
    }
  } else {
    // 小程序
    vueLoaderOption = {
      optimizeSSR: false,
      transformAssetUrls: {
        video: ['src', 'poster'],
        'live-player': 'src',
        audio: 'src',
        source: 'src',
        image: 'src',
        'cover-image': 'src'
      },
      compilerOptions: {
        whitespace: 'condense',
        modules: [{
          preTransformNode (el) {
            const nodeName = el.tag
            if (capitalize(toCamelCase(nodeName)) in internalComponents) {
              data.componentConfig.includes.add(nodeName)
            }

            if (nodeName === CUSTOM_WRAPPER) {
              data.componentConfig.thirdPartyComponents.set(CUSTOM_WRAPPER, new Set())
            }

            const usingComponent = data.componentConfig.thirdPartyComponents.get(nodeName)
            if (usingComponent != null) {
              el.attrsList
                .filter(a => !a.dynamic)
                .forEach(a => usingComponent.add(a.name.startsWith(':') ? a.name.slice(1) : a.name))
            }

            return el
          }
        }],
        mustUseProp: function () {
          return false
        }
      }
    }
  }

  chain.module
    .rule('vue')
    .test(REG_VUE)
    .use('vueLoader')
    .loader(vueLoaderPath)
    .options(vueLoaderOption)
}

function setLoader (chain) {
  function customizer (object = '', sources = '') {
    if ([object, sources].every(e => typeof e === 'string')) return object + sources
  }
  if (process.env.TARO_PLATFORM === 'web') {
    chain.plugin('mainPlugin')
      .tap(args => {
        args[0].loaderMeta = mergeWith(
          getLoaderMeta(), args[0].loaderMeta, customizer
        )
        return args
      })
  } else {
    chain.plugin('miniPlugin')
      .tap(args => {
        args[0].loaderMeta = getLoaderMeta()
        return args
      })
  }
}

function setAlias (chain) {
  // 避免 npm link 时，taro composition apis 使用的 vue 和项目使用的 vue 实例不一致。
  chain.resolve.alias
    .set('vue', require.resolve('vue'))
}

function viteCommonPlugin (): PluginOption {
  return {
    name: 'taro-vue2:common',
    config: () => ({
      resolve: {
        dedupe: process.env.NODE_ENV !== 'production' ? ['vue'] : []
      }
    })
  }
}
