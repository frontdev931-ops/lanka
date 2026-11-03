import { MOCK_KEY, startMock } from './cliniccards-mock';

// Run: npm run mock:cliniccards
// Then in apps/api/.env: CLINICCARDS_BASE_URL=http://127.0.0.1:4010/api
// and on the "Integrations" page connect the key from the output below.
startMock({}, 4010).then((m) => {
  console.log(`Имитация Cliniccards: ${m.url}`);
  console.log(`Ключ API: ${MOCK_KEY}`);
  console.log(`Пациентов: ${m.data.patients.length}, записей: ${m.data.visits.length}, пунктов плана: ${m.data.planItems.length}`);
});
