# План: явная подготовка инфраструктуры очереди

Статус: план, реализация не начата. Дата: 2026-09-17.

План относится только к `@adaptivestone/framework-module-resize`. Он не должен
содержать код, пути, модели или порядок запуска конкретного приложения-потребителя.
Работать в ветке `codex-upload-original-queue-reliability`, сохраняя уже сделанные
в ней изменения queue reliability и uploadOriginal.

## Проблема

Модуль объявляет индексы `ResizeTask` и использует framework-модель `Lock`, но не
предоставляет способ подготовить эти зависимости при отключённом `autoIndex`.
В результате каждый потребитель вынужден знать внутренние модели конкретных драйверов
и самостоятельно вызывать `createIndexes()`.

Проблема реальна для уже поставляемых конфигураций:

- `MongoTransport` требует индексы зарегистрированной модели `ResizeTask`;
- `FrameworkLockProvider` требует TTL-индекс framework-модели `Lock`;
- `SqsTransport` не требует `ResizeTask`, но может использовать стандартный
  `FrameworkLockProvider`;
- eager-режим без транспорта не использует очередь и locks.

Цель — дать потребителю один явный вызов подготовки, сохранив независимость
транспорта и провайдера блокировок:

```ts
await resizer.prepareQueue();
```

Метод не создаёт задания, не запускает worker, не обрабатывает изображения и не
создаёт внешние ресурсы вроде SQS queue или S3 bucket.

## Публичный контракт

Расширить существующие интерфейсы только необязательными методами:

```ts
export interface QueueTransport {
  prepare?(): Promise<void>;
  // существующие методы без изменений
}

export interface LockProvider {
  prepare?(): Promise<void>;
  // существующие методы без изменений
}

export class Resizer {
  prepareQueue(): Promise<void>;
}
```

Необязательность сохраняет совместимость существующих custom drivers. Отсутствие
`prepare()` означает только, что драйвер не объявляет локального шага подготовки.
Это не универсальная health-check или проверка существования внешнего сервиса.

Поведение комбинаций:

| Конфигурация | `prepareQueue()` |
|---|---|
| Нет transport | Сразу завершается; lock provider не вызывается |
| Mongo + framework locks | Готовит `ResizeTask`, затем `Lock` |
| SQS/custom transport без prepare + framework locks | Готовит только `Lock` |
| Mongo + custom locks без prepare | Готовит только `ResizeTask` |
| Оба custom drivers без prepare | Успешный no-op |

## Реализация

### 1. Контракты

Изменить:

- `src/transports/AbstractTransport.ts`;
- `src/locks/AbstractLockProvider.ts`.

Добавить необязательный `prepare?(): Promise<void>` с коротким JSDoc: метод
подготавливает инфраструктуру конкретного драйвера и должен быть безопасен при
повторном вызове.

Не добавлять общий lifecycle interface, registry ресурсов, readiness state или
новый базовый класс драйвера.

### 2. MongoTransport

В `src/transports/mongo.ts` добавить публичный `prepare()`:

1. Получить `getApp().getModel('ResizeTask')`.
2. Если модель отсутствует или не имеет `createIndexes`, бросить `ResizeSetupError`
   с понятным кодом и сообщением о scaffold/регистрации модели.
3. Ожидать `model.createIndexes()`; определения индексов остаются только в
   `src/models/ResizeTask.ts`.
4. Ошибку БД обернуть в `ResizeError` с кодом `RESIZE_QUEUE_PREPARE_FAILED`,
   указанием `MongoTransport/ResizeTask` и исходной ошибкой в `cause`.
5. Уже существующий `ResizeError` не оборачивать повторно.

Не использовать мягкий `taskModel()` как успешную подготовку: runtime transport
может сохранить существующее soft-fail поведение, но явный prepare обязан сообщить
о неправильной регистрации.

Не применять `syncIndexes`, `dropIndexes`, `listIndexes` или собственное описание
полей. `createIndexes()` добавляет объявленные моделью индексы и должен явно упасть
при конфликте существующих данных/индексов.

### 3. FrameworkLockProvider

В `src/locks/framework.ts` добавить публичный `prepare()` по тем же правилам:

1. Получить `getApp().getModel('Lock')`.
2. Проверить модель и `createIndexes`.
3. Ожидать `createIndexes()`.
4. Оборачивать операционную ошибку с кодом `RESIZE_QUEUE_PREPARE_FAILED`, `cause`
   и указанием `FrameworkLockProvider/Lock`.

Не менять `acquire`, `release`, TTL, единицы времени или ключи блокировок.

### 4. Resizer.prepareQueue

В `src/resizer.ts` добавить приватный кэш:

```ts
#queuePreparation: Promise<void> | undefined;
```

И метод со следующими гарантиями:

1. Без transport сразу вернуть resolved Promise и не обращаться к framework app.
2. Выполнить `transport.prepare?.()`, затем `lockProvider.prepare?.()`.
3. Одновременные вызовы одного Resizer разделяют одну подготовку.
4. После успеха повторные вызовы не обращаются к драйверам снова.
5. После ошибки кэш сбрасывается; следующий явный вызов повторяет всю последовательность.
6. Нет автоматических retries, timers или rollback успешно созданных индексов.
7. Синхронный throw пользовательского JS-драйвера превращается в rejected Promise.
8. Ошибку custom driver обернуть в `ResizeError` с кодом
   `RESIZE_QUEUE_PREPARE_FAILED` и `cause`; существующий `ResizeError` сохранить.

Рекомендуемая форма координации:

```ts
prepareQueue(): Promise<void> {
  const transport = this.transport;
  if (!transport) return Promise.resolve();

  if (!this.#queuePreparation) {
    this.#queuePreparation = Promise.resolve()
      .then(async () => {
        await transport.prepare?.();
        await this.lockProvider.prepare?.();
      })
      .catch((error: unknown) => {
        this.#queuePreparation = undefined;
        throw normalizeQueuePreparationError(error);
      });
  }
  return this.#queuePreparation;
}
```

Helper нормализации держать внутренним и небольшим. Не экспортировать новое состояние
подготовки и не добавлять production reset API. Конструктор остаётся синхронным.

Не вызывать подготовку скрыто из `resolve`, `prewarm`, `enqueueRequired`, `generate`,
`enqueue`, `acquire` или конструкторов. Producer-процесс вызывает её явно в подходящей
точке bootstrap либо обеспечивает индексы собственной миграцией.

### 5. Штатный worker

В `src/worker.ts` после проверки `worker.enabled` и наличия transport, но до настройки
и запуска `transport.startWorker`, выполнить:

```ts
const resizer = getResizer();
await resizer.prepareQueue();
```

Таким образом, поставляемые `runResizeWorker` и `ResizeWorker` безопасно готовят
выбранные драйверы без host subclass только ради индексов. Ошибка подготовки должна
отменить запуск worker и дойти до CLI; не логировать её как успешную остановку.

Не запускать worker автоматически в API-процессе.

### 6. SQS и прочие драйверы

В `SqsTransport`, storage и mediaStore не добавлять `prepare`, пока нет реальной
локальной операции подготовки. SQS queue, redrive policy, credentials, buckets и IAM
остаются внешней конфигурацией.

Не добавлять тестовую или фиктивную подготовку ради одинакового вида классов.

## Тесты

### Resizer unit tests

Расширить `src/resizer.test.ts`:

- проверить все строки таблицы комбинаций;
- доказать порядок transport → locks управляемыми Promise;
- 10 конкурентных вызовов выполняют каждый prepare один раз;
- повтор после успеха ничего не вызывает;
- ошибка transport не вызывает locks и допускает повтор;
- ошибка locks допускает повтор всей последовательности;
- синхронный throw custom driver сохраняется как `cause`;
- eager без transport не требует установленного framework app.

Проверять вызовы и ожидание, а не только равенство возвращённых Promise.

### Driver unit tests

В `src/transports/mongo.test.ts` и `src/locks/framework.test.ts` проверить:

- выбор правильного имени модели;
- ожидание незавершённого `createIndexes()`;
- отсутствие модели/метода;
- сохранение операционной ошибки в `cause`;
- отсутствие изменений в существующих рабочих методах.

### Worker tests

Расширить тесты `runResizeWorker`:

- prepare завершается до `startWorker`;
- worker не стартует при ошибке prepare;
- disabled worker остаётся no-op и не выполняет prepare;
- отсутствие transport сохраняет текущее поведение.

### Mongo integration

Добавить focused integration test с временной MongoDB:

1. Использовать изолированную БД и явно отключить автоматическое индексирование.
2. Построить реальные схемы `ResizeTaskModel` и framework `Lock`, не копируя индексы.
3. Создать коллекции без вторичных индексов.
4. Установить test app и Resizer с `MongoTransport`/`FrameworkLockProvider`.
5. Вызвать `prepareQueue()`.
6. Через `listIndexes()` доказать наличие partial unique индекса ResizeTask и TTL
   индекса Lock. Ожидать работу TTL monitor не нужно.
7. Выполнить 20 одинаковых прямых `transport.enqueue()` параллельно: один непустой
   taskId и одна активная запись. Не использовать prewarm, потому что dispatch locks
   могут скрыть отсутствие unique index.
8. Повторный вызов и новый Resizer над той же БД должны завершиться успешно.
9. Очистить только ресурсы, созданные тестом.

## Документация и package surface

Обновить `README.md`, `AGENTS.md` и `CHANGELOG.md`:

- показать `await resizer.prepareQueue()` после регистрации моделей/подключения БД
  и до producer-операций;
- объяснить, что штатный worker готовится самостоятельно;
- указать, что eager-only подготовка не нужна;
- объяснить SQS + framework locks;
- предупредить о правах и времени на `createIndexes()`;
- разрешить потребителям с собственными миграциями не вызывать prepare в producer,
  если необходимые индексы гарантированно созданы заранее;
- не обещать проверку внешнего SQS/S3 ресурса или исправление конфликтов схемы.

При необходимости уточнить scaffold-комментарии, но не добавлять сложный lifecycle
bootstrap и не менять существующие exports/subpaths. `Resizer.prepareQueue` попадёт в
declaration класса при сборке; отдельная функция main-entry не нужна. Конкретные классы
драйверов должны экспортировать свои методы через существующие subpaths.

## Проверки

Выполнить:

```bash
npm run types:check
npm run check
npm test
npm run build
npm run smoke
```

Проверить итоговый `dist`/`.d.ts` и packed consumer: метод доступен у Resizer,
MongoTransport и FrameworkLockProvider; optional методы присутствуют в интерфейсах.

Не публиковать пакет, не создавать tag, не делать push/merge и не менять version без
отдельного решения владельца. В конце сообщить изменённые файлы, результаты проверок
и источник протестированного npm-артефакта.

## Критерии готовности

- [ ] Ядро не знает конкретных моделей или БД драйверов.
- [ ] MongoTransport сам готовит ResizeTask.
- [ ] FrameworkLockProvider сам готовит Lock.
- [ ] SQS не требует ResizeTask и не получает выдуманный prepare.
- [ ] Eager без transport не затрагивает очередь и locks.
- [ ] Конкурентные вызовы, кэш успеха и повтор после ошибки проверены.
- [ ] Штатный worker ждёт подготовку до начала consumption.
- [ ] Реальная Mongo с autoIndex=false получает необходимые индексы.
- [ ] Существующие custom drivers остаются совместимы.
- [ ] Собранный и упакованный публичный API проверен.
