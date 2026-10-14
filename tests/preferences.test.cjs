'use strict'

const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {loadProxyPort,saveProxyPort}=require('../electron/preferences.cjs')

test('proxy port defaults to 10808, persists and recovers from invalid settings',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qaletx-preferences-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const file=path.join(directory,'preferences.json')
  assert.equal(loadProxyPort(file),10808)
  saveProxyPort(file,12080)
  assert.equal(loadProxyPort(file),12080)
  for(const value of [0,65536,1.2,'12080']) assert.throws(()=>saveProxyPort(file,value),/端口/)
  assert.equal(loadProxyPort(file),12080)
  fs.writeFileSync(file,'not-json')
  assert.equal(loadProxyPort(file),10808)
})
