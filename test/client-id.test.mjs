#!/usr/bin/env node
/**
 * 客户端 bundle 的 ModuleLoader id 必须等于 npm 包名。
 *
 * 校验点（对应 dsh-client-modules 的 arrive()）：
 * - `window.__ModuleLoader__.load({ id })` 的 id 是模块图的 row id；
 * - 它与 `package.json` 的 `name` 不一致时，Loader 认为"加载了但没注册"，
 *   再用 fallback URL 把同一 bundle 执行一遍，第二次触发
 *   `duplicate factory registration` → `web boot: 1 entry did not activate`
 *   → renderer recovery exhausted，窗口打不开。
 *
 * 运行：node test/client-id.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const client = await readFile(new URL('client.js', root), 'utf8')

const loader = /window\.__ModuleLoader__\.load\(\{([\s\S]*?)\n\}\)/.exec(client)
assert.ok(loader, 'client.js must call window.__ModuleLoader__.load({ ... })')

const idMatch = /(^|\n)\s*id:\s*(['"])([^'"]+)\2/.exec(loader[1])
assert.ok(idMatch, 'client.js must declare a string literal `id:` as the first key')

assert.equal(
  idMatch[3],
  pkg.name,
  `client bundle id must equal package name: got "${idMatch[3]}", expected "${pkg.name}"`,
)

console.log(`client-id ok: ${idMatch[3]}`)
