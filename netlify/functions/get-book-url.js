const { createClient } = require('@supabase/supabase-js');

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TTL_SECONDS = Number(process.env.BOOK_LINK_TTL_SECONDS || 1800);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };

  let bookId;
  try {
    ({ bookId } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!bookId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing bookId' }) };

  // 1) Who is calling? (validates the JWT against Supabase Auth)
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session' }) };
  }
  const userId = userData.user.id;

  // 2) Entitlement check — admin, or an explicit student_books grant for this exact book.
  const { data: profile } = await admin.from('profiles').select('role, blocked').eq('id', userId).single();
  if (!profile || profile.blocked) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Account blocked or not found' }) };
  }
  const isAdmin = profile.role === 'admin' || profile.role === 'mainadmin';

  const { data: book } = await admin.from('books').select('*').eq('id', bookId).single();
  if (!book) return { statusCode: 404, body: JSON.stringify({ error: 'Book not found' }) };

  if (!isAdmin) {
    const { data: grant } = await admin
      .from('student_books')
      .select('book_id')
      .eq('student_id', userId)
      .eq('book_id', bookId)
      .maybeSingle();
    if (!grant) return { statusCode: 403, body: JSON.stringify({ error: 'You do not have access to this book' }) };
  }

  // 3) Issue a short-lived signed URL — the real storage path is never sent to the browser.
  const { data: signed, error: signErr } = await admin.storage
    .from('books')
    .createSignedUrl(book.storage_path, TTL_SECONDS);

  if (signErr || !signed) {
    return { statusCode: 500, body: JSON.stringify({ error: signErr?.message || 'Could not sign URL' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ url: signed.signedUrl, bookName: book.book_name, expiresIn: TTL_SECONDS }),
  };
};
