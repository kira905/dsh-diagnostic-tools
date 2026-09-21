// ============================================================
//  dsh-home.mjs — DSH home / workspace 解析
//  ------------------------------------------------------------
//  解析优先级（高 → 低）：
//    home      ：显式参数  >  $DSH_HOME        >  ~/.dsh
//    workspace ：显式参数  >  $DSH_WORKSPACE   >  由被重定向的 home 推导  >  当前工作目录
//
//  「空 / 纯空白」的取值一律视为**未设置**（避免解析到空路径或意外的 cwd）。
//
//  兼容性：不设置任何环境变量时，home = `~/.dsh`（与 DSH 自身的默认位置一致）。
//  本文件不做任何写操作，也不内置任何与本机盘符相关的默认值 ——
//  陌生环境里「猜一个绝对路径」比回落到 cwd 更危险。
// ============================================================
import os from 'node:os'
import path from 'node:path'

/** 环境变量的非空取值（空串 / 纯空白视为未设置）。 */
export function envValue(name) {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : null
}

/** 解析 DSH home 绝对路径：参数 > `$DSH_HOME` > `~/.dsh`。 */
export function resolveDshHome(configured) {
  if (configured) return path.resolve(configured)
  const override = envValue('DSH_HOME')
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.dsh')
}

/** home 是否被重定向到非默认位置（仅用于日志提示与安全自检）。 */
export function isNonDefaultHome(configured) {
  const def = path.resolve(path.join(os.homedir(), '.dsh'))
  return path.resolve(resolveDshHome(configured)) !== def
}

/**
 * 解析工作区根（派生数据所在的那棵树，例如 `<workspace>/generated`）。
 * 优先级：参数 > `$DSH_WORKSPACE` > 由被重定向的 home 推导（`<dir>/.dsh` ⇒ `<dir>`）> 当前工作目录。
 * ⚠️ 推导的判据是「home 被环境变量显式重定向」而不是「路径层数够」——
 *   默认 home 也是三层（`~/.dsh`），按层数判会把它错推成用户主目录。
 */
export function resolveDshWorkspace(configured) {
  if (configured) return path.resolve(configured)
  const env = envValue('DSH_WORKSPACE')
  if (env) return path.resolve(env)
  const home = resolveDshHome(null)
  if (isNonDefaultHome(null) && path.basename(home).toLowerCase() === '.dsh') {
    return path.resolve(path.dirname(home))
  }
  return path.resolve(process.cwd())
}

/** 人类可读的来源标注（`--print-config` 用）。 */
export function describeHomeSource(configured) {
  if (configured) return 'cli'
  return envValue('DSH_HOME') ? 'env:DSH_HOME' : 'default'
}

/** 人类可读的来源标注（`--print-config` 用）。 */
export function describeWorkspaceSource(configured) {
  if (configured) return 'cli'
  if (envValue('DSH_WORKSPACE')) return 'env:DSH_WORKSPACE'
  const home = resolveDshHome(null)
  if (isNonDefaultHome(null) && path.basename(home).toLowerCase() === '.dsh') return 'derived:from-home'
  return 'default:cwd'
}
