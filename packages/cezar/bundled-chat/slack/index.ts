import { createSlackAdapter } from '../../src/chat/providers/slack/bundled-adapter.ts'

// The bundled artifact has no host objects or callbacks in its public boundary.
export default { createAdapter: createSlackAdapter }
