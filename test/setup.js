// Global in-memory chrome.* mock, reset before each test.
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
function createChromeMock() {
  let store = {};
  const changeListeners = [];
  return {
    _store: () => store,
    storage: {
      local: {
        get: jest.fn(async (key) => {
          if (key == null) return { ...store };
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, clone(store[k])]));
        }),
        set: jest.fn(async (items) => {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = clone(v);
          }
          changeListeners.forEach((l) => l(changes, 'local'));
        }),
        clear: jest.fn(async () => { store = {}; })
      },
      onChanged: { addListener: jest.fn((l) => changeListeners.push(l)) }
    },
    action: {
      setBadgeText: jest.fn(async () => {}),
      setBadgeBackgroundColor: jest.fn(async () => {}),
      setBadgeTextColor: jest.fn(async () => {}),
      setTitle: jest.fn(async () => {})
    },
    alarms: {
      create: jest.fn(async () => {}),
      clear: jest.fn(async () => true),
      get: jest.fn(async () => undefined),
      onAlarm: { addListener: jest.fn() }
    },
    runtime: {
      sendMessage: jest.fn(async () => ({ ok: true })),
      openOptionsPage: jest.fn(),
      onMessage: { addListener: jest.fn() },
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() }
    }
  };
}

beforeEach(() => {
  global.chrome = createChromeMock();
  global.fetch = jest.fn();
});
