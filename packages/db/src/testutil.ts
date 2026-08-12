// Entegrasyon testleri için: ClickHouse/Redis ayakta değilse testler atlanır.
import { createCh } from './client.js';

export async function clickhouseUp(): Promise<boolean> {
  const ch = createCh({ database: 'default' });
  try {
    await ch.query({ query: 'SELECT 1' });
    return true;
  } catch {
    return false;
  } finally {
    await ch.close();
  }
}
