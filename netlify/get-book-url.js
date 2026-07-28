
// netlify/functions/get-book-url.js
//
// Called by BookReader.jsx as POST /api/get-book-url with { bookId } and the
// student's access token. Uses the SERVICE ROLE key (server-side only, never
// shipped to the browser) to re-check entitlement and mint a short-lived
// signed URL into the private "books" storage bucket — the real storage
// path never reaches the client.
//
// Entitled = admin/mainadmin, OR has a student_books row for this book,
// OR has an enrollments row for the book's course_id.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  const token = authHeader ? authHeader.replace('Bearer ', '') : null;
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Missing auth token' }) };

  let bookId;
  try {
    ({ bookId } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  if (!bookId) return { statusCode: 400, body: JSON.stringify({ error: 'bookId required' }) };

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Verify the caller's identity from their own access token.
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) };
  }
  const userId = userData.user.id;

  const { data: book, error: bookErr } = await admin
    .from('books').select('*').eq('id', bookId).single();
  if (bookErr || !book) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Book not found' }) };
  }

  const { data: profile } = await admin
    .from('profiles').select('role, blocked').eq('id', userId).single();
  if (profile && profile.blocked) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Account blocked' }) };
  }
  const isAdmin = profile && (profile.role === 'admin' || profile.role === 'mainadmin');

  if (!isAdmin) {
    const [{ data: assigned }, enrolledResult] = await Promise.all([
      admin.from('student_books').select('book_id')
        .eq('student_id', userId).eq('book_id', bookId).maybeSingle(),
      book.course_id
        ? admin.from('enrollments').select('course_id')
            .eq('student_id', userId).eq('course_id', book.course_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const enrolled = enrolledResult.data;
    if (!assigned && !enrolled) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Not entitled to this book' }) };
    }
  }

  const { data: signed, error: signErr } = await admin.storage
    .from('books')
    .createSignedUrl(book.storage_path, 60 * 10); // 10 minutes

  if (signErr || !signed) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not create signed URL' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ url: signed.signedUrl }) };
};
