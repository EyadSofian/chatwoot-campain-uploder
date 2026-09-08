import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTemplateVariables,
  findApprovedTemplateDefinition,
  parseParamMap,
} from '../server/templateParams.js';

const nationalDayMessage = `🇸🇦🔥 عرض اليوم الوطني بدأ… وإنت لسه بتفكر؟

شهر جديد = فرص جديدة 💼
وسوق العمل كل يوم بيطلب مهارات أقوى وتأهيل أفضل.

🎓 احجز دورتك… وخد باكدج تدريبي كامل + أكثر من هدية مجانًا!

دورتك + باكدج تدريبي + هدايا إضافية = قيمة أكبر بدون تكلفة إضافية 🔥

#عرض_اليوم_الوطني`;

test('equals signs and hashtags inside a multiline value do not create phantom parameters', () => {
  const params = parseParamMap(`1=${nationalDayMessage}`);

  assert.deepEqual(Object.keys(params), ['1']);
  assert.match(params['1'], /شهر جديد = فرص جديدة/);
  assert.match(params['1'], /هدايا إضافية = قيمة أكبر/);
  assert.match(params['1'], /#عرض_اليوم_الوطني/);
});

test('numeric and named template mappings are still parsed independently', () => {
  assert.deepEqual(parseParamMap('1=name\n2=course_name'), {
    1: 'name',
    2: 'course_name',
  });
  assert.deepEqual(parseParamMap('customer_name=name\ncourse=course_name'), {
    customer_name: 'name',
    course: 'course_name',
  });
});

test('approved template definition supplies the authoritative BODY variables', () => {
  const definition = findApprovedTemplateDefinition({
    message_templates: [{
      name: 'confirm_step',
      language: 'ar',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{
        type: 'BODY',
        text: 'مرحباً {{1}}،\n\nتم تسجيل طلبك للتحقق من الحساب، وجاري مراجعته.',
      }],
    }],
  }, 'confirm_step', 'ar');

  assert.equal(definition.name, 'confirm_step');
  assert.equal(definition.category, 'UTILITY');
  assert.deepEqual(definition.bodyVariables, ['1']);
  assert.deepEqual(extractTemplateVariables(definition.body), ['1']);
});
