/**
 * Движок сценариев: экран = адрес + последовательность действий.
 *
 * Базовых экранов мало, а состояний много: модалки, подтверждения, тосты,
 * пустые состояния, результаты поиска. Каждое из них — отдельный кадр в
 * макете, и каждое обязано сверяться, иначе правка на проде не доедет.
 *
 * Поэтому состояния описываются данными, а не кодом: чтобы добавить экран,
 * достаточно дописать сценарий в конфиг.
 *
 * Шаги:
 *   { "click": "текст кнопки" }        клик по видимому элементу с таким текстом
 *   { "clickSelector": ".btn-primary" } клик по селектору
 *   { "type": { "selector": "…", "text": "…" } }
 *   { "waitFor": ".modal-overlay" }    дождаться появления
 *   { "waitGone": ".spinner" }         дождаться исчезновения
 *   { "wait": 500 }                    пауза, когда иначе никак
 *   { "press": "Escape" }
 */

const DEFAULT_TIMEOUT = 8000;

/** Ищет видимый элемент по вхождению текста. Кнопки часто содержат эмодзи. */
async function clickByText(page, text) {
  const done = await page.evaluate((wanted) => {
    const visible = (el) => el.offsetHeight > 0 && el.offsetWidth > 0;
    const candidates = [...document.querySelectorAll('button, a, [role="button"], .sidebar-item, .tab')];
    const target = candidates.filter(visible).find((el) => el.textContent.replace(/\s+/g, ' ').includes(wanted));
    if (!target) return false;
    target.click();
    return true;
  }, text);

  if (!done) throw new Error(`не найден кликабельный элемент с текстом «${text}»`);
}

/**
 * Выполняет один шаг сценария.
 * Ошибка шага гасит сценарий целиком: снимок после несработавшего клика
 * покажет не то состояние и будет хуже отсутствия снимка.
 */
async function runStep(page, step) {
  if (step.click !== undefined) return clickByText(page, step.click);

  // Та же болезнь, что описана ниже у waitFor, только с другого конца:
  // waitForSelector резолвит селектор в ПЕРВОЕ совпадение и ждёт видимости
  // именно его. На 390px админка прячет таблицу и рисует вместо неё карточки
  // .mcard — строка таблицы остаётся в DOM первой и невидимой навсегда, из-за
  // чего «mobile/База клієнтів» отваливалась по таймауту, пока desktop с тем
  // же сценарием проходил. Ждём и кликаем первый ВИДИМЫЙ узел из совпадений:
  // тогда один селектор через запятую покрывает оба представления списка.
  if (step.clickSelector !== undefined) {
    const handle = await page.waitForFunction(
      (sel) => [...document.querySelectorAll(sel)]
        .find((el) => el.offsetWidth > 0 && el.offsetHeight > 0) ?? null,
      step.clickSelector,
      { timeout: step.timeout ?? DEFAULT_TIMEOUT },
    );
    const element = handle.asElement();
    if (!element) throw new Error(`не найден видимый узел: ${step.clickSelector}`);
    return element.click();
  }

  if (step.type !== undefined) {
    await page.waitForSelector(step.type.selector, { state: 'visible', timeout: DEFAULT_TIMEOUT });
    await page.fill(step.type.selector, step.type.text);
    // Часть фильтров реагирует на input, а не на change — добиваем событием.
    return page.dispatchEvent(step.type.selector, 'input');
  }

  // Ждём ЛЮБОЙ подходящий узел, а не первый в разметке. waitForSelector
  // резолвит селектор в первое совпадение, а в админке все модалки лежат в
  // DOM скрытыми, и `.modal-overlay` — это всегда «Нова заявка». Её сценарий
  // проходил, а курс, статья и карточка клиента ждали чужую модалку до
  // таймаута и снимались как «не удалось».
  if (step.waitFor !== undefined) {
    return page.waitForFunction(
      (sel) => [...document.querySelectorAll(sel)].some((el) => el.offsetWidth > 0 && el.offsetHeight > 0),
      step.waitFor,
      { timeout: step.timeout ?? DEFAULT_TIMEOUT },
    );
  }

  if (step.waitGone !== undefined) {
    return page.waitForFunction(
      (sel) => [...document.querySelectorAll(sel)].every((el) => el.offsetWidth === 0 && el.offsetHeight === 0),
      step.waitGone,
      { timeout: step.timeout ?? DEFAULT_TIMEOUT },
    );
  }

  if (step.press !== undefined) return page.keyboard.press(step.press);
  if (step.wait !== undefined) return page.waitForTimeout(step.wait);

  throw new Error(`неизвестный шаг: ${JSON.stringify(step)}`);
}

/**
 * Приводит страницу в состояние сценария.
 * @returns {Promise<{ok: boolean, failedAt?: number, reason?: string}>}
 */
export async function applyScenario(page, steps = []) {
  for (const [index, step] of steps.entries()) {
    try {
      await runStep(page, step);
    } catch (error) {
      return { ok: false, failedAt: index + 1, reason: error.message.split('\n')[0] };
    }
  }
  // Состояния часто анимированы (модалка выезжает); анимации погашены стилем,
  // но раскладка после вставки узлов всё равно устаканивается не мгновенно.
  await page.waitForTimeout(400);
  return { ok: true };
}

/**
 * Возвращает страницу в исходное состояние, чтобы следующий сценарий
 * не наследовал открытую модалку. Дешевле перезагрузки, но если состояние
 * закрыть не удалось, вызывающий код должен перезагрузить страницу.
 */
export async function resetState(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const clean = await page.evaluate(() => {
    const open = [...document.querySelectorAll('.modal-overlay, .sched-popup, .phone-popup')]
      .filter((el) => el.offsetHeight > 0);
    for (const el of open) {
      const close = el.querySelector('[data-close], .modal-close, .close');
      if (close) close.click();
    }
    return [...document.querySelectorAll('.modal-overlay')].every((el) => el.offsetHeight === 0);
  });
  return clean;
}
