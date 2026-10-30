import { decrypt, encrypt } from '../src/common/crypto';
import { CliniccardsClient, CliniccardsError, resolveBaseUrl } from '../src/integrations/cliniccards.client';

describe('шифрование ключа', () => {
  it('расшифровывает то, что зашифровано, и не хранит ключ открытым', () => {
    const enc = encrypt('super-secret-api-key');
    expect(enc).not.toContain('super-secret');
    expect(decrypt(enc)).toBe('super-secret-api-key');
  });

  it('при каждом шифровании результат разный', () => {
    expect(encrypt('x')).not.toBe(encrypt('x'));
  });

  it('подделанные данные не расшифровываются', () => {
    const [iv, tag] = encrypt('abc').split('.');
    const broken = [iv, tag, Buffer.from('zzzz').toString('base64')].join('.');
    expect(() => decrypt(broken)).toThrow();
  });
});

describe('клиент Cliniccards: белый список', () => {
  const client = new CliniccardsClient('key', { baseUrl: 'http://127.0.0.1:1', minIntervalMs: 0 });

  // Все пути записи и всё, чего нет в списке чтения, отклоняются до любого сетевого запроса
  it.each(['/receive-patients-payment', '/invoice', '/save-deposit', '/spendings', '/stock-invoice', '/stock-products', '/files/1', '/anything'])(
    'не пускает запрос к %s',
    async (path) => {
      await expect(client.get(path)).rejects.toThrow('Путь не разрешён');
    },
  );

  it('пути чтения финансов разрешены (доступ ограничен ролями в приложении)', async () => {
    // порт 1 закрыт: ошибка должна быть про связь, а не про белый список
    await expect(client.get('/payments')).rejects.toThrow('нет связи');
    await expect(client.get('/invoices')).rejects.toThrow('нет связи');
  });
});

describe('адрес Cliniccards', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('в разработке адрес можно подменить переменной окружения', () => {
    process.env.NODE_ENV = 'development';
    process.env.CLINICCARDS_BASE_URL = 'http://localhost:4010/api';
    expect(resolveBaseUrl()).toBe('http://localhost:4010/api');
  });

  it('в продакшене переменная игнорируется, чтобы ключ клиники не ушёл на чужой адрес', () => {
    process.env.NODE_ENV = 'production';
    process.env.CLINICCARDS_BASE_URL = 'https://evil.example.com/api';
    expect(resolveBaseUrl()).toBe('https://cliniccards.com/api');
  });
});

describe('время Cliniccards (часовой пояс клиники)', () => {
  // Импорт внутри теста, чтобы не менять шапку файла
  it('летнее и зимнее время Киева переводится в UTC', async () => {
    const { localToUtc } = await import('../src/common/clinic-time');
    expect(localToUtc('2026-06-11 11:00:00').toISOString()).toBe('2026-06-11T08:00:00.000Z'); // UTC+3
    expect(localToUtc('2026-11-22 15:00:00').toISOString()).toBe('2026-11-22T13:00:00.000Z'); // UTC+2
    expect(localToUtc('2026-03-29 12:00:00').toISOString()).toBe('2026-03-29T09:00:00.000Z'); // день перевода часов
  });
});
