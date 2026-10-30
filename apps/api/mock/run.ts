import { MOCK_KEY, startMock } from './cliniccards-mock';

// Запуск: npm run mock:cliniccards
// Затем в apps/api/.env: CLINICCARDS_BASE_URL=http://127.0.0.1:4010/api
// и на странице «Інтеграції» подключить ключ из вывода ниже.
startMock({}, 4010).then((m) => {
  console.log(`Имитация Cliniccards: ${m.url}`);
  console.log(`Ключ API: ${MOCK_KEY}`);
  console.log(`Пациентов: ${m.data.patients.length}, записей: ${m.data.visits.length}, пунктов плана: ${m.data.planItems.length}`);
});
