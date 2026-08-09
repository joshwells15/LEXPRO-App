// LEXPRO :: get-calendar.js (team-app port)
// Pulls Transactions Calendar appointments for a contact or date range.

const GHL_API_KEY = process.env.GHL_API_KEY || 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';
const CALENDAR_ID = '1VHA9skkdov7k2J2cja4';
const LOCATION_ID = 'R5PobkV1CRO23kz95yYB';

exports.handler = async (event) => {
  const { contactId, startDate, endDate } = event.queryStringParameters || {};
  const params = new URLSearchParams({
    locationId: LOCATION_ID,
    calendarId: CALENDAR_ID,
    appointmentStatus: 'confirmed',
    ignoreDateRange: 'true',
  });
  if (startDate) params.set('startTime', new Date(startDate).getTime());
  if (endDate) params.set('endTime', new Date(endDate).getTime());
  if (contactId) params.set('contactId', contactId);
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments?${params}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.message || 'GHL error' }) };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointments: data.appointments || [] }),
    };
  } catch (err) {
    console.error('get-calendar error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
