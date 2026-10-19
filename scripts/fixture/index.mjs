import process from 'node:process'
import console from 'node:console'
import { createFixture, removeFixture } from './home.mjs'
import { simulate, STEPS } from './simulate.mjs'

const [command, home, step] = process.argv.slice(2)
try {
  switch (command) {
    case 'create': {
      if (home !== undefined && home !== 'codex' && home !== 'claude')
        throw new Error('Usage: create [codex|claude] (tool to omit)')
      console.log(JSON.stringify(await createFixture({ missingTool: home }), null, 2))
      break
    }
    case 'simulate':
      console.log(JSON.stringify(await simulate(home, step)))
      break
    case 'clean':
      await removeFixture(home)
      console.log(JSON.stringify({ clean: true }))
      break
    default:
      console.log(
        `Usage: npm run fixture -- create [codex|claude]\n       npm run fixture -- simulate <absolute-home> <step>\n       npm run fixture -- clean <absolute-home>\nSteps: ${STEPS.join(', ')}`
      )
  }
} catch {
  // Do not echo source contents or arbitrary exception text.
  console.error(
    'Fixture command failed. Check the command, synthetic temp home and step; run without arguments for help.'
  )
  process.exitCode = 1
}
