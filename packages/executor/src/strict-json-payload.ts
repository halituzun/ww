// Denetim kaydı yükünün katı JSON'a normalleştirilmesi.
//
// @ww/agents içindeki toStrictJson ile aynı kural; executor o pakete bağımlı
// olmadığı için burada durur. JSON'da `undefined` yoktur: araç sonucundaki
// tek tanımsız alan tüm denetim kaydını, dolayısıyla görevi düşürüyordu.
// JSON karşılığı olmayan değerler SESSİZCE düşürülmez.
export function toStrictJsonPayload(value: unknown, path = ''): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`katı JSON'a çevrilemedi (${path || 'kök'}): sonlu olmayan sayı`);
    }
    return value;
  }
  if (type === 'undefined') throw new Error(`katı JSON'a çevrilemedi (${path || 'kök'}): undefined`);
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    throw new Error(`katı JSON'a çevrilemedi (${path || 'kök'}): ${type} JSON değildir`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => (
      item === undefined ? null : toStrictJsonPayload(item, `${path}[${index}]`)
    ));
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (source[key] === undefined) continue;
    output[key] = toStrictJsonPayload(source[key], path === '' ? key : `${path}.${key}`);
  }
  return output;
}
