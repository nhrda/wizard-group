const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// --- Configuración ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

// Fechas en zona Argentina
function getArgentinaDate(offsetDays = 0) {
  const now = new Date();
  const arg = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  arg.setDate(arg.getDate() + offsetDays);
  const y = arg.getFullYear();
  const m = String(arg.getMonth() + 1).padStart(2, '0');
  const d = String(arg.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

async function main() {
  const hoy = getArgentinaDate(0);
  const manana = getArgentinaDate(1);

  console.log(`Hoy: ${hoy} | Mañana: ${manana}`);

  const snap = await db.doc('wizardgroup/estado').get();
  if (!snap.exists) {
    console.log('No existe el documento de estado');
    return;
  }

  const data = snap.data();
  const agenda = (data.agenda || []).filter(e => e.estado === 'activo');
  const polizas = data.polizas || [];

  // Agenda
  const agendaHoy = agenda.filter(e => e.fecha === hoy);
  const agendaManana = agenda.filter(e => e.fecha === manana);

  // Pólizas que vencen
  const polizasHoy = polizas.filter(p => p.vencimiento === hoy);
  const polizasManana = polizas.filter(p => p.vencimiento === manana);

  const hayHoy = agendaHoy.length > 0 || polizasHoy.length > 0;
  const hayManana = agendaManana.length > 0 || polizasManana.length > 0;

  if (!hayHoy && !hayManana) {
    console.log('No hay novedades. No se envía mail.');
    return;
  }

  // Armar HTML
  let html = '';

  if (hayHoy) {
    html += `<h3 style="color:#051721; margin-top:24px;">Para hoy (${formatDate(hoy)})</h3><ul>`;
    agendaHoy.forEach(e => {
      html += `<li><strong>Agenda:</strong> ${e.desarrollo}</li>`;
    });
    polizasHoy.forEach(p => {
      html += `<li><strong>Póliza vence:</strong> ${p.asegurado}${p.numero ? ' — ' + p.numero : ''}</li>`;
    });
    html += `</ul>`;
  }

  if (hayManana) {
    html += `<h3 style="color:#AA7452; margin-top:28px; border-top:1px solid #eee; padding-top:16px;">
      Para mañana (${formatDate(manana)})
    </h3><ul>`;
    agendaManana.forEach(e => {
      html += `<li><strong>Agenda:</strong> ${e.desarrollo}</li>`;
    });
    polizasManana.forEach(p => {
      html += `<li><strong>Póliza vence:</strong> ${p.asegurado}${p.numero ? ' — ' + p.numero : ''}</li>`;
    });
    html += `</ul>`;
  }

  // Lista de destinatarios (uno o varios)
  const destinatarios = [
    process.env.EMAILJS_TO_EMAIL_1,
    process.env.EMAILJS_TO_EMAIL_2
  ].filter(email => email && email.trim() !== '');

  if (destinatarios.length === 0) {
    console.log('No hay destinatarios configurados');
    return;
  }

  for (const email of destinatarios) {
    const payload = {
      service_id: process.env.EMAILJS_SERVICE_ID,
      template_id: process.env.EMAILJS_TEMPLATE_ID,
      user_id: process.env.EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {
        message_html: html,
        to_email: email
     }
  };

    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      console.log(`Mail enviado correctamente a ${email}`);
    } else {
      const text = await res.text();
      console.error(`Error al enviar mail a ${email}:`, text);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
