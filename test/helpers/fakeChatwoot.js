// In-memory Chatwoot that mimics the behaviour that matters for attribute
// safety: POST /conversations/:id/custom_attributes REPLACES the whole hash.
// Other integrations are simulated by hooks that edit state directly, so the
// request log only contains the uploader's own calls.
export function createFakeChatwoot({ accountId = '2' } = {}) {
  const conversations = new Map();
  const contacts = new Map();
  const requests = [];
  const hooks = [];
  const failures = [];
  const accountLabels = new Set();
  let nextConversationId = 7000;
  let nextMessageId = 90000;
  let nextContactId = 500;

  function addContact({ id = nextContactId++, phone, name = 'Test', labels = [], inboxSourceIds = {} }) {
    contacts.set(String(id), {
      id,
      name,
      phone_number: phone,
      custom_attributes: {},
      labels: [...labels],
      contact_inboxes: Object.entries(inboxSourceIds).map(([inboxId, sourceId]) => ({
        source_id: sourceId,
        inbox: { id: Number(inboxId) },
      })),
    });
    return contacts.get(String(id));
  }

  function addConversation({ id = nextConversationId++, contactId, inboxId = 24, status = 'open', labels = [], attributes = {} }) {
    conversations.set(String(id), {
      id,
      inbox_id: Number(inboxId),
      contact_id: contactId,
      status,
      labels: [...labels],
      custom_attributes: { ...attributes },
      meta: {},
      messages: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    return conversations.get(String(id));
  }

  // hook(request, api) runs after the uploader's request is applied.
  function after(match, hook) {
    hooks.push({ match, hook });
  }

  // The next matching request fails with `status` without touching state.
  function failOnce(match, status) {
    failures.push({ match, status });
  }

  function attributes(conversationId) {
    return { ...conversations.get(String(conversationId)).custom_attributes };
  }

  // Another integration writing its own keys the same unsafe way Chatwoot allows.
  function otherWriterMerge(conversationId, values) {
    const conversation = conversations.get(String(conversationId));
    conversation.custom_attributes = { ...conversation.custom_attributes, ...values };
  }

  function otherWriterReplace(conversationId, hash) {
    conversations.get(String(conversationId)).custom_attributes = { ...hash };
  }

  async function fetch(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const parsed = new URL(String(url));
    const prefix = `/api/v1/accounts/${accountId}`;
    const path = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : parsed.pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    const request = { method, path, body };
    requests.push(request);

    const failure = failures.findIndex(({ match }) => match(request));
    const response = failure >= 0
      ? { status: failures.splice(failure, 1)[0].status, body: { error: 'simulated failure' } }
      : route(method, path, parsed, body);
    request.response = clone(response.body ?? {});
    for (const { match, hook } of hooks) {
      if (match(request)) await hook(request, api);
    }
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
  }

  function route(method, path, parsed, body) {
    let m;
    if (method === 'GET' && path === '/labels') {
      return { body: { payload: [...accountLabels].map((title) => ({ title })) } };
    }
    if (method === 'POST' && path === '/labels') {
      accountLabels.add(body.title);
      return { body: { title: body.title } };
    }
    if (method === 'GET' && path === '/contacts/search') {
      const q = String(parsed.searchParams.get('q') || '').replace(/\D/g, '');
      const payload = [...contacts.values()].filter((c) => String(c.phone_number).replace(/\D/g, '') === q);
      return { body: { payload: clone(payload) } };
    }
    if ((m = path.match(/^\/contacts\/(\d+)\/labels$/))) {
      const contact = contacts.get(m[1]);
      if (method === 'POST') contact.labels = [...body.labels];
      return { body: { payload: [...contact.labels] } };
    }
    if ((m = path.match(/^\/contacts\/(\d+)\/conversations$/)) && method === 'GET') {
      const payload = [...conversations.values()].filter((c) => String(c.contact_id) === m[1]);
      return { body: { payload: clone(payload) } };
    }
    if ((m = path.match(/^\/contacts\/(\d+)$/))) {
      const contact = contacts.get(m[1]);
      if (method === 'PATCH') contact.custom_attributes = { ...contact.custom_attributes, ...body.custom_attributes };
      return { body: { payload: clone(contact) } };
    }
    if (method === 'POST' && path === '/conversations') {
      const conversation = addConversation({
        contactId: body.contact_id,
        inboxId: body.inbox_id,
        status: body.status,
        attributes: body.custom_attributes || {},
      });
      return { body: clone(conversation) };
    }
    if ((m = path.match(/^\/conversations\/(\d+)$/)) && method === 'GET') {
      const conversation = conversations.get(m[1]);
      return conversation ? { body: clone(conversation) } : { status: 404, body: { error: 'not found' } };
    }
    if ((m = path.match(/^\/conversations\/(\d+)\/labels$/))) {
      const conversation = conversations.get(m[1]);
      if (method === 'POST') conversation.labels = [...body.labels];
      return { body: { payload: [...conversation.labels] } };
    }
    if ((m = path.match(/^\/conversations\/(\d+)\/custom_attributes$/)) && method === 'POST') {
      const conversation = conversations.get(m[1]);
      conversation.custom_attributes = { ...body.custom_attributes };
      return { body: { custom_attributes: clone(conversation.custom_attributes) } };
    }
    if ((m = path.match(/^\/conversations\/(\d+)\/messages$/)) && method === 'POST') {
      const conversation = conversations.get(m[1]);
      const message = { id: nextMessageId++, status: api.nextMessageStatus || 'sent', content: body.content };
      if (message.status === 'failed') {
        message.content_attributes = { external_error: '131000: simulated delivery failure' };
      }
      conversation.messages.push(message);
      return { body: message };
    }
    if ((m = path.match(/^\/conversations\/(\d+)\/assignments$/)) && method === 'POST') {
      const conversation = conversations.get(m[1]);
      if ('assignee_id' in body) conversation.meta.assignee = body.assignee_id ? { id: body.assignee_id, name: `Agent ${body.assignee_id}` } : null;
      if ('team_id' in body) conversation.meta.team = body.team_id ? { id: body.team_id } : null;
      return { body: {} };
    }
    if ((m = path.match(/^\/conversations\/(\d+)\/toggle_status$/)) && method === 'POST') {
      conversations.get(m[1]).status = body.status;
      return { body: {} };
    }
    return { status: 404, body: { error: `fake Chatwoot has no route for ${method} ${path}` } };
  }

  const api = {
    fetch,
    requests,
    after,
    failOnce,
    addContact,
    addConversation,
    attributes,
    otherWriterMerge,
    otherWriterReplace,
    conversations,
    nextMessageStatus: 'sent',
  };
  return api;
}

export function isAttributeWrite(request, conversationId) {
  return request.method === 'POST'
    && request.path === `/conversations/${conversationId}/custom_attributes`;
}

export function isConversationRead(request, conversationId) {
  return request.method === 'GET' && request.path === `/conversations/${conversationId}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
