// The wiki hotkey (`itemLib.wiki`): a unique opens under its title, anything else under its base type.
export function wikiUrl(item: { rarity?: string; title?: string | null; baseKey?: string; baseName?: string }): string {
  const unique = item.rarity === 'UNIQUE' || item.rarity === 'RELIC';
  const name = (unique ? item.title : item.baseKey ?? item.baseName) ?? item.baseName ?? '';
  return 'https://www.poewiki.net/wiki/' + name.replace(/ /g, '_');
}
