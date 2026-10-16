const mods = ['core/entities', 'core/control', 'core/store', 'core/queue', 'core/lease', 'core/budget', 'core/commands', 'core/completion', 'core/recovery', 'core/kernel', 'rotation/lines', 'rotation/policy', 'rotation/latch', 'rotation/fsm', 'rotation/brief', 'rotation/facts', 'adapter/host-types', 'adapter/services', 'adapter/dsh', 'adapter/capabilities', '../vendor/redaction']
let bad = 0
for (const m of mods) {
  try {
    const x = await import(`./src/${m}.ts`)
    console.log('OK  ', m, Object.keys(x).length, 'exports')
  } catch (error) {
    bad += 1
    console.log('FAIL', m, String(error).split('\n').slice(0, 3).join(' | '))
  }
}
console.log(bad === 0 ? 'ALL LOADED' : `${bad} FAILED`)
for (const m of ['adapter/rotation-runner', 'views/export']) {
  try { const x = await import(`./src/${m}.ts`); console.log('OK  ', m, Object.keys(x).length) }
  catch (e) { console.log('FAIL', m, String(e).split('\n').slice(0,4).join(' | ')) }
}
