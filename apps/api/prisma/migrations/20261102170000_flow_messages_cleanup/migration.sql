-- Scripted messages of the booking flow were first saved as AI replies (they used up the AI's daily allowance per chat)
-- and the booking confirmation with an administrator as author (it paused the AI). Both are only marks on old rows.
UPDATE "ChatMessage"
SET "byAi" = false
WHERE "direction" = 'OUT' AND "byAi" = true AND (
     "text" LIKE 'Щоб передати заявку адміністратору, підкажіть%'
  OR "text" LIKE 'Дякуємо! Підкажіть, будь ласка, ваше прізвище%'
  OR "text" LIKE 'Дякуємо! Підкажіть, будь ласка, номер телефону%'
  OR "text" LIKE 'Дякуємо! Передали заявку%'
  OR "text" LIKE 'На жаль, цей час уже зайнятий%'
  OR "text" LIKE 'Ваш запис підтверджено ✅%'
  OR "text" LIKE 'Чтобы передать заявку администратору%'
  OR "text" LIKE 'Спасибо! Подскажите, пожалуйста, вашу фамилию%'
  OR "text" LIKE 'Спасибо! Подскажите, пожалуйста, номер телефона%'
  OR "text" LIKE 'Спасибо! Передали заявку%'
  OR "text" LIKE 'К сожалению, это время уже занято%'
  OR "text" LIKE 'Ваша запись подтверждена ✅%'
);

UPDATE "ChatMessage"
SET "authorUserId" = NULL, "byAi" = false
WHERE "externalId" LIKE 'bookconfirm:%' AND "direction" = 'OUT';
