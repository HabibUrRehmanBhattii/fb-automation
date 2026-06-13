// grok-description-worker.js
// Hidden, isolated process that embodies "Grok" for high-converting Marketplace descriptions.
// The main Electron process forks this (via child_process.fork) so generation never blocks
// the UI or Playwright. Completely hidden — no console, no visible CLI.

process.on('message', (msg) => {
  if (msg && msg.type === 'generate' && msg.folderName) {
    const desc = generateGrokDescription(msg.folderName);
    process.send({ type: 'result', description: desc });
    // Exit after one job — keeps it lightweight and truly isolated
    setTimeout(() => process.exit(0), 50);
  }
});

function generateGrokDescription(folderName) {
  // Strip special chars, numbers, underscores, and dashes
  let clean = String(folderName || '').replace(/[^\w\s-]/g, '');
  clean = clean.replace(/[\d_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Professional Marketplace Optimizer template baked in for raw 3D DIY cosplay kits.
  // Sets strict expectations (supports, sanding, etc.) and Toronto local focus.
  // This is the "Grok" output when the isolated worker is used.
  return `Up your cosplay game with this 3D-printed ${clean}. This is a raw, unfinished DIY kit straight off the print bed, ready for your custom finishing!

️ THE DETAILS:
• Scale: 1:1 True-to-size (fits most adults).
• Condition: Raw 3D print. Support structures may still be attached to protect the finer details during transport.
• Work Required: This is a DIY kit! It will require standard prep work (sanding, priming, assembling, and painting) to achieve that perfect screen-accurate finish.
• Materials: Printed in durable, high-quality PLA/PETG. (Default colors are usually Grey, Black, or White depending on filament availability).
• Accessories: Any included visors or lenses are printed solid (non-transparent) unless otherwise stated.

 CUSTOM SIZING: Have a specific head measurement? I can easily scale this up or down. Just shoot me a message before buying!

 LOGISTICS:
Local pickup in Toronto. Cash or e-transfer. First come, first served! Message me with any questions or for exact dimensions.`;
}

// If run directly, just exit silently.
if (require.main === module) {
  process.exit(0);
}
