// One manifest, two doors: the UI dispatches these commands, and an agent calls the same entries.
export const STOCKS = [
  { id: 'portra400', name: 'Portra 400', note: 'Colour negative on Portra Endura paper' },
  { id: 'ektar100', name: 'Ektar 100', note: 'Colour negative on Portra Endura paper' },
  { id: 'velvia100', name: 'Velvia 100', note: 'Slide film, viewed directly' },
];

export const DEFAULTS = { ev: 0, print: 0, y: 0, m: 0, grain: true, halation: true };

const range = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description });

export function createCommands(app) {
  const history = [];
  const manifest = [
    { name: 'get_state', description: 'Read the current stock, settings, photo size and credit line.',
      inputSchema: { type: 'object', properties: {} }, handler: () => app.snapshot() },
    { name: 'list_stocks', description: 'List the film stocks and how each is finished.',
      inputSchema: { type: 'object', properties: {} }, handler: () => STOCKS },
    { name: 'set_stock', description: 'Switch film stock.',
      inputSchema: { type: 'object', properties: { id: { enum: STOCKS.map(s => s.id) } }, required: ['id'] },
      handler: ({ id }) => app.setStock(id) },
    { name: 'set_exposure', description: 'Over- or underexpose the film in stops. The printer corrects brightness, so this changes contrast and colour.',
      inputSchema: { type: 'object', properties: { ev: range(-2, 2, 'Stops') }, required: ['ev'] },
      handler: ({ ev }) => app.update({ ev }) },
    { name: 'set_print_exposure', description: 'Make the print lighter or darker, in stops. Has no effect on slide film.',
      inputSchema: { type: 'object', properties: { stops: range(-1, 1, 'Stops') }, required: ['stops'] },
      handler: ({ stops }) => app.update({ print: stops }) },
    { name: 'set_filters', description: 'Shift the enlarger yellow and magenta filters, in CC units. Has no effect on slide film.',
      inputSchema: { type: 'object', properties: { y: range(-20, 20, 'Yellow'), m: range(-20, 20, 'Magenta') } },
      handler: ({ y, m }) => app.update({ ...(y === undefined ? {} : { y }), ...(m === undefined ? {} : { m }) }) },
    { name: 'set_grain', description: 'Turn film grain on or off.',
      inputSchema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
      handler: ({ on }) => app.update({ grain: on }) },
    { name: 'set_halation', description: 'Turn halation (the glow around bright areas) on or off.',
      inputSchema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
      handler: ({ on }) => app.update({ halation: on }) },
    { name: 'reset', description: 'Return every setting to its default. Keeps the photo and stock.',
      inputSchema: { type: 'object', properties: {} }, handler: () => app.update({ ...DEFAULTS }) },
    { name: 'load_photo', description: 'Load a photo from a data URL or a Blob. The photo stays in this tab.',
      inputSchema: { type: 'object', properties: { source: { description: 'Data URL string or Blob' } }, required: ['source'] },
      handler: ({ source }) => app.loadPhoto(source) },
    { name: 'render_photo', description: 'Render the photo at full size and return it as a data URL, without saving a file.',
      inputSchema: { type: 'object', properties: { type: { enum: ['image/jpeg', 'image/png'] } } },
      handler: ({ type }) => app.renderDataUrl(type) },
    { name: 'download_photo', description: 'Render the photo at full size and save it to the person\'s downloads.',
      inputSchema: { type: 'object', properties: {} }, handler: () => app.download() },
  ];

  const byName = new Map(manifest.map(t => [t.name, t]));
  const dispatch = async (name, args = {}, door = 'ui') => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown command ${name}`);
    history.push({ at: new Date().toISOString(), name, door });
    return tool.handler(args);
  };

  const tools = Object.fromEntries(manifest.map(t => [t.name, args => dispatch(t.name, args, 'window')]));
  window.argentix = { tools, manifest: manifest.map(({ handler, ...t }) => t), history };
  if (navigator.modelContext?.registerTool) {
    for (const t of manifest) {
      navigator.modelContext.registerTool({ name: t.name, description: t.description, inputSchema: t.inputSchema,
        execute: async args => ({ content: [{ type: 'text', text: JSON.stringify(await dispatch(t.name, args, 'modelContext')) ?? '' }] }) });
    }
  }
  return dispatch;
}
