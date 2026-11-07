package expo.modules.mailsocket

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import jakarta.activation.CommandMap
import jakarta.activation.MailcapCommandMap
import jakarta.mail.AuthenticationFailedException
import jakarta.mail.Message
import jakarta.mail.MessagingException
import jakarta.mail.SendFailedException
import jakarta.mail.Session
import jakarta.mail.Transport
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeMessage
import java.util.Date
import java.util.Properties
import java.util.UUID
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException

private const val STARTTLS_PORT = 587
private const val TLS_PORT = 465
private const val TIMEOUT_MS = "30000"
// Printable ASCII only in anything that reaches an SMTP command or a raw header. CVE-2025-7962 turned characters such as U+760D into a
// carriage return when a 16-bit character was cut to a byte. Angus 2.0.4 and later refuse that themselves; this is the second lock.
private const val ADDRESS_PART = "[\\x21-\\x7e&&[^@<>,;:\"()\\[\\]\\\\]]+"
private val ADDRESS = Regex("^$ADDRESS_PART@$ADDRESS_PART$")
private val MESSAGE_ID = Regex("<[\\x21-\\x7e&&[^<>]]+>")
// Line breaks of every kind, so a subject stays one line.
private val CONTROL = Regex("[\\x00-\\x1f\\x7f\\u0085\\u2028\\u2029]")

class OutgoingMail : Record {
  @Field var host: String = ""
  @Field var user: String = ""
  @Field var password: String = ""
  @Field var from: String = ""
  @Field var to: List<String> = emptyList()
  @Field var subject: String = ""
  @Field var body: String = ""
  @Field var inReplyTo: String? = null
  @Field var references: String? = null
}

private fun session(host: String, port: Int, implicitTls: Boolean): Session {
  val key = if (implicitTls) "mail.smtps" else "mail.smtp"
  val properties = Properties().apply {
    put("$key.host", host)
    put("$key.port", port.toString())
    put("$key.auth", "true")
    put("$key.connectiontimeout", TIMEOUT_MS)
    put("$key.timeout", TIMEOUT_MS)
    put("$key.writetimeout", TIMEOUT_MS)
    // The machine's own name stays out of the greeting.
    put("$key.localhost", "kamil")
    put("$key.ssl.checkserveridentity", "true")
    // Asking for what this Android does not have would fail the whole connection: TLS 1.3 starts at Android 10.
    put("$key.ssl.protocols", SSLContext.getDefault().supportedSSLParameters.protocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.joinToString(" "))
    if (!implicitTls) {
      // Required, not just wanted: without it a stranger on the network could strip the encryption and read the password.
      put("$key.starttls.enable", "true")
      put("$key.starttls.required", "true")
    }
  }
  return Session.getInstance(properties)
}

private fun code(error: Exception): CodedException {
  var cause: Throwable? = error
  while (cause != null) {
    if (cause is SSLException) return CodedException("ERR_MAIL_CERTIFICATE", "The connection could not be secured", null)
    cause = cause.cause
  }
  return when (error) {
    is AuthenticationFailedException -> CodedException("ERR_MAIL_AUTH", "The server refused the login", null)
    is SendFailedException -> CodedException("ERR_MAIL_RECIPIENT", "The server refused the mail", null)
    else -> CodedException("ERR_MAIL_SEND", "The mail could not be sent", null)
  }
}

/** The Message-ID is written here: by default it would carry the phone's own host name. */
private class Outgoing(session: Session, private val id: String) : MimeMessage(session) {
  override fun updateMessageID() = setHeader("Message-ID", id)
}

/** Connects first, on 587 and then on 465, so that a failed connection can move on but a mail can never go twice. Returns its Message-ID. */
fun sendMail(mail: OutgoingMail): String {
  if (!ADDRESS.matches(mail.from) || mail.to.isEmpty() || mail.to.any { !ADDRESS.matches(it) }) {
    throw CodedException("ERR_MAIL_RECIPIENT", "An address is not valid", null)
  }
  // Android has no default class path for these: the text handler is named outright.
  Thread.currentThread().contextClassLoader = Session::class.java.classLoader
  (CommandMap.getDefaultCommandMap() as MailcapCommandMap).let {
    it.addMailcap("text/plain;; x-java-content-handler=org.eclipse.angus.mail.handlers.text_plain")
    CommandMap.setDefaultCommandMap(it)
  }
  val domain = mail.from.substringAfter('@')
  val id = "<${UUID.randomUUID()}@$domain>"
  var session = session(mail.host, STARTTLS_PORT, false)
  var transport: Transport = session.getTransport("smtp")
  try {
    try {
      transport.connect(mail.user, mail.password)
    } catch (error: MessagingException) {
      val refused = code(error)
      if (refused.code != "ERR_MAIL_SEND") throw refused
      session = session(mail.host, TLS_PORT, true)
      transport = session.getTransport("smtps")
      transport.connect(mail.user, mail.password)
    }
    val message = Outgoing(session, id).apply {
      setFrom(InternetAddress(mail.from, true))
      setRecipients(Message.RecipientType.TO, mail.to.map { InternetAddress(it, true) }.toTypedArray())
      setSubject(mail.subject.replace(CONTROL, " "), "UTF-8")
      setText(mail.body.replace("\r\n", "\n").replace('\r', '\n'), "UTF-8")
      sentDate = Date()
      mail.inReplyTo?.takeIf { MESSAGE_ID.matches(it) }?.let { setHeader("In-Reply-To", it) }
      val references = MESSAGE_ID.findAll(mail.references ?: "").map { it.value }.toList().takeLast(10)
      if (references.isNotEmpty()) setHeader("References", references.joinToString(" "))
      saveChanges()
    }
    transport.sendMessage(message, message.allRecipients)
    return id
  } catch (error: CodedException) {
    throw error
  } catch (error: MessagingException) {
    throw code(error)
  } finally {
    runCatching { transport.close() }
  }
}
