/**
 * Persistent bottom menu (Telegram reply keyboard) so common actions are one tap away —
 * no scrolling. Buttons send their label as text; resolveMenu() maps the label back to a
 * command before routing.
 */

export const MENU_KEYBOARD = {
  keyboard: [
    ["📋 Posisi", "➕ Add LP"],
    ["🪜 Ladder3", "🪜 Ladder5"],
    ["🗑 LdrClose", "🔄 Swap"],
    ["🔎 Krystal", "👛 Wallet"],
    ["💰 PnL", "📸 Kartu"],
    ["📒 Ledger", "⚙️ Settings"],
    ["❔ Help"],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const MENU_MAP: Record<string, string> = {
  "📋 Posisi": "/list",
  "➕ Add LP": "/addlp",
  "🪜 Ladder3": "/ladder3",
  "🪜 Ladder5": "/ladder5",
  "🗑 LdrClose": "/ladderclose",
  "🔄 Swap": "/swap",
  "🔎 Krystal": "/krystal",
  "👛 Wallet": "/wallet",
  "💰 PnL": "/pnl",
  "📸 Kartu": "/card",
  "📒 Ledger": "/ledger",
  "⚙️ Settings": "/settings",
  "❔ Help": "/help",
};

/** Menu label → command, or the text unchanged. */
export function resolveMenu(text: string): string {
  return MENU_MAP[text] ?? text;
}
