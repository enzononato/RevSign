// REVALLE (Fase 7): o que os scripts desta pasta dividem. Eles rodam DENTRO da imagem do Playwright, chamados por
// `runBrowserScript` (helpers.mjs): o WSL não abre o Chromium. A entrada é a variável BROWSER_PAYLOAD (JSON). Cada
// conferência escreve uma linha (`ok ...` ou `FALHOU ...`), e o script sai com código 1 se alguma falhar. Com SHOT_DIR,
// guarda os prints (a pasta precisa estar montada no container).
import { chromium } from 'playwright';

export const payload = JSON.parse(process.env.BROWSER_PAYLOAD ?? '{}');

const shotDir = process.env.SHOT_DIR;
const failures = [];

export const report = (passed, message) => {
  console.log(`${passed ? 'ok' : 'FALHOU'} ${message}`);

  if (!passed) {
    failures.push(message);
  }
};

export const browser = await chromium.launch();

// Contexto novo com a sessão de `cookie` (sem cookie, ninguém entrou). `viewport` padrão: computador.
export const openAs = async (cookie, viewport = { width: 1280, height: 900 }) => {
  const context = await browser.newContext({ viewport, locale: 'pt-BR' });

  if (cookie) {
    await context.addCookies(
      cookie.split('; ').map((pair) => {
        const index = pair.indexOf('=');

        return { name: pair.slice(0, index), value: pair.slice(index + 1), url: payload.baseUrl };
      }),
    );
  }

  const page = await context.newPage();

  page.setDefaultTimeout(30_000);

  return { context, page };
};

export const shot = async (page, name, options = {}) => {
  if (shotDir) {
    await page.screenshot({ path: `${shotDir}/${name}.png`, ...options });
  }
};

// Cada bloco roda isolado: um erro (elemento que não apareceu) vira uma falha com o motivo e os outros blocos seguem.
export const section = async (name, fn) => {
  try {
    await fn();
  } catch (error) {
    report(false, `${name}: ${String(error.message).split('\n')[0]}`);
  }
};

export const finish = async () => {
  await browser.close();

  if (failures.length > 0) {
    console.log(`\n${failures.length} conferência(s) falharam`);
  }

  process.exit(failures.length > 0 ? 1 : 0);
};
