import axios from 'axios';
import type { Page } from 'puppeteer';
import { getImages } from './images';
import { getTarget } from './target';
import type { subscriptionType } from './type';
import { getApiUrl, random, sleep } from './utils';

/**
 * Solve captchas using `nocaptchaai.com` API service
 *
 * @param page - Puppeteer page instance
 * @param apiKey - API key
 * @param subscriptionType - `free` or `pro`
 * @param attempts - Number of attemps if solver fails (default is `3`)
 * @param attempsTimeout - The time in `ms` which solver will be looking for a new challenge before throw error (default is `30000`)
 * @param debug - `true` or `false` (default is `false`)
 */

export const solveCaptcha = async (
  page: Page,
  apiKey: string,
  subscriptionType: subscriptionType,
  attemps = 3,
  attempsTimeout = 30000,
  debug = false
): Promise<void> => {
  const outer = await page.waitForSelector('iframe[data-hcaptcha-response]');
  const outerFrame = await outer?.contentFrame();
  const inner = await page.waitForSelector('iframe:not([data-hcaptcha-response])');
  const innerFrame = await inner?.contentFrame();
  if (!outerFrame) throw new Error('solveCaptcha: captcha outer frame not found');
  if (!innerFrame) throw new Error('solveCaptcha: captcha inner frame not found');

  const checkbox = await outerFrame.waitForSelector('#checkbox');

  if (!(await innerFrame.$('.challenge'))) await checkbox?.click();
  const language = await innerFrame.evaluate(() => document.documentElement.lang);
  if (debug) console.log('* Language found = ', language);

  let currentAttempt = 1;
  let isSolved = false;
  let skip = false;
  let target = '';

  try {
    while (currentAttempt <= attemps && !isSolved) {
      if (debug) console.log(`Current attempt: ${currentAttempt} / ${attemps}`);

      let sitekey = await page.$eval('.h-captcha', el => el.getAttribute('data-sitekey'));
      if (!sitekey) sitekey = new URLSearchParams(innerFrame.url()).get('sitekey');

      await innerFrame.waitForSelector('.challenge-container', { timeout: 10 * 1000 });
      while ((await outerFrame.$('#checkbox[aria-checked=false]')) !== null && !skip) {
        const images = await getImages(innerFrame);
        if (debug && images) console.log('* Puzzle Images found');

        target = await getTarget(innerFrame);
        if (debug && target) console.log('* Target = ', target);

        const imageElements = await innerFrame.$$('.task-image');
        if (!imageElements) throw new Error('solveCaptcha: captcha images not found');

        const { data: query } = await axios.post(
          getApiUrl(subscriptionType),
          {
            softid: 'pptr-pkg',
            method: 'hcaptcha_base64',
            site: page.url(),
            ln: language,
            sitekey,
            images,
            target
          },
          {
            headers: { 'Content-type': 'application/json', 'apikey': apiKey }
          }
        );

        skip = query.status === 'skip';

        switch (query.status) {
          case 'solved': {
            if (debug) console.log('* Status = ', query.status);
            for (const item of query.solution) {
              await imageElements[item].click();
              await sleep(random(200, 350));
            }

            break;
          }

          case 'new': {
            if (debug) console.log('* Waiting a second');

            for (let i = 0; i < 10; i++) {
              await sleep(1000);
              const { data: result } = await axios.get(query.url);

              if (result.status === 'solved') {
                if (debug) console.log('* Clicking images');

                for (const item of result.solution) {
                  await imageElements[item].click();

                  await sleep(random(200, 350));
                }

                break;
              }
            }

            break;
          }

          case 'skip': {
            if (debug) console.log('* Seems this a new challenge...');
            if (debug) console.log('Looking for a known challenge');

            let timeOut = false;
            const timer: ReturnType<typeof setTimeout> = setTimeout(
              () => (timeOut = true),
              attempsTimeout
            );

            while (target == (await getTarget(innerFrame))) {
              const reloadButton = await innerFrame.$('.refresh.button');
              await reloadButton?.click();
              await sleep(1000);
              if (timeOut) throw new Error('Timeout looking for a new challenge');
            }
            skip = false;
            clearTimeout(timer);
            currentAttempt++;
            break;
          }

          case 'error': {
            console.error(query.message);
            throw new Error('* Error');
          }

          default: {
            console.error(query);
            throw new Error('* Unknown status');
          }
        }

        const button = await innerFrame.$('.button-submit');
        await button?.click();

        if (debug) console.log('* Waiting a second');
        await sleep(1000);
      }

      isSolved = (await outerFrame.$('#checkbox[aria-checked=true]')) !== null;

      if (debug && isSolved) console.log('* Puzzle solved');
    }
  } catch (err) {
    if (debug) console.error(err);
  }

  if (!isSolved) throw new Error('Captcha could not be solved');
};
