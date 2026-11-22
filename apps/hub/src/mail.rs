use anyhow::Context;
use lettre::message::Mailbox;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

pub struct Mailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl Mailer {
    /// `url` like `smtps://user:pass@host:465` or `smtp://user:pass@host:587?tls=required`.
    pub fn new(url: &str, from: &str) -> anyhow::Result<Self> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .context("invalid SMTP_URL")?
            .build();
        let from = from.parse().context("invalid SMTP_FROM")?;
        Ok(Mailer { transport, from })
    }

    pub async fn send_code(&self, to: &str, code: &str) -> anyhow::Result<()> {
        let msg = Message::builder()
            .from(self.from.clone())
            .to(to.parse().context("invalid recipient")?)
            .subject(format!("Your Cuna code: {code}"))
            .body(format!(
                "Your Cuna login code is {code}\n\nIt works for 10 minutes. If you did not ask for it, ignore this mail.\n"
            ))?;
        self.transport.send(msg).await.context("sending mail")?;
        Ok(())
    }
}
