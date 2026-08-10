// LEXPRO :: get-calendar.js v3
// Lists Transactions Calendar appointments via the CORRECT GHL list route:
//   GET /calendars/events  (Version 2021-04-15)  — requires startTime & endTime
// The old /calendars/events/appointments path is create/single-only and 404s on GET.
// Optional contactId filtering happens here in the function.

const GHL_API_KEY = process.env.GHL_API_KEY || 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';
const CALENDAR_ID = '1VHA9skkdov7k2J2cja4';
const LOCATION_ID = 'R5PobkV1CRO23kz95yYB';

exports.handler = async (event) => {
  const { contactId, startDate, endDate } = event.queryStringParameters || {};
  const start = startDate ? new Date(startDate).getTime() : Date.now() - 90 * 86400000;
  const end = endDate ? new Date(endDate).getTime() : Date.now() + 548 * 86400000;
  const params = new URLSearchParams({
    locationId: LOCATION_ID,
    calendarId: CALENDAR_ID,
    startTime: String(start),
    endTime: String(end),
  });
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/calendars/events?${params}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-04-15',
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('GHL calendar error:', JSON.stringify(data));
      return { statusCode: res.status, body: JSON.stringify({ error: data.message || data.error || 'GHL error' }) };
    }
    let events = data.events || data.appointments || [];
    // keep confirmed (or unstatused) appointments
    events = events.filter(e => !e.appointmentStatus || e.appointmentStatus === 'confirmed');
    if (contactId) events = events.filter(e => e.contactId === contactId);
    const appointments = events.map(e => ({
      id: e.id,
      title: e.title || '',
      startTime: e.startTime || '',
      endTime: e.endTime || '',
      contactId: e.contactId || '',
      appointmentStatus: e.appointmentStatus || ''
    }));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointments })
    };
  } catch (err) {
    console.error('get-calendar error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
