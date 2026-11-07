package expo.modules.mailsocket

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import jakarta.activation.CommandMap
import jakarta.mail.FetchProfile
import jakarta.mail.Folder
import jakarta.mail.Part
import jakarta.mail.UIDFolder
import jakarta.mail.internet.ContentType
import jakarta.mail.internet.MimeMultipart
import jakarta.mail.internet.MimePart
import jakarta.mail.internet.MimePartDataSource
import jakarta.mail.internet.MimeUtility
import jakarta.mail.search.ComparisonTerm
import jakarta.mail.search.ReceivedDateTerm
import jakarta.activation.MailcapCommandMap
import jakarta.mail.AuthenticationFailedException
import jakarta.mail.Flags
import jakarta.mail.Message
import jakarta.mail.MessagingException
import jakarta.mail.SendFailedException
import jakarta.mail.Session
import jakarta.mail.Transport
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeMessage
import org.eclipse.angus.mail.imap.IMAPFolder
import java.io.ByteArrayInputStream
import java.nio.charset.Charset
import java.util.Date
import java.util.Properties
import java.util.UUID
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException

private const val STARTTLS_PORT = 587
private const val TLS_PORT = 465
private const val TIMEOUT_MS = "30000"
private val SENT_NAMES = listOf("Sent", "Sent Items", "Sent Messages", "INBOX.Sent", "Gönderilmiş", "Gönderilenler", "Gönderilmiş Öğeler")
// Printable ASCII only in anything that reaches an SMTP command or a raw header. CVE-2025-7962 turned characters such as U+760D into a
// carriage return when a 16-bit character was cut to a byte. Angus 2.0.4 and later refuse that themselves; this is the second lock.
private const val ADDRESS_PART = "[\\x21-\\x7e&&[^@<>,;:\"()\\[\\]\\\\]]+"
private val ADDRESS = Regex("^$ADDRESS_PART@$ADDRESS_PART$")
private val MESSAGE_ID = Regex("<[\\x21-\\x7e&&[^<>]]+>")
// Line breaks of every kind, so a subject stays one line.
private val CONTROL = Regex("[\\x00-\\x1f\\x7f\\u0085\\u2028\\u2029]")

class MailAccount : Record {
  @Field var host: String = ""
  @Field var port: Int = 993
  @Field var user: String = ""
  @Field var password: String = ""
}

class ReadRequest : Record {
  @Field var host: String = ""
  @Field var port: Int = 993
  @Field var user: String = ""
  @Field var password: String = ""
  @Field var uidvalidity: Double? = null
  @Field var lastUid: Double? = null
  @Field var sinceMs: Double = 0.0
}

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
  @Field var imapPort: Int = 993
  @Field var saveCopy: Boolean = true
}

class SendResult : Record {
  @Field var id: String = ""
  @Field var sentCopy: Boolean = false
}

private fun session(host: String, port: Int, key: String): Session {
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
    // Not enough on Android: Angus asks for the LDAPS check, and a mail went to a server with another name's certificate in testing.
    // So Android's own strict verifier is named outright, the same one the reading side uses.
    put("$key.ssl.hostnameverifier", HttpsURLConnection.getDefaultHostnameVerifier())
    // Asking for what this Android does not have would fail the whole connection: TLS 1.3 starts at Android 10.
    put("$key.ssl.protocols", SSLContext.getDefault().supportedSSLParameters.protocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.joinToString(" "))
    // Mail is strangers' writing, so it may be broken: a bad part must cost that part, not the whole mail.
    put("mail.mime.address.strict", "false")
    put("mail.mime.decodetext.strict", "false")
    put("mail.mime.base64.ignoreerrors", "true")
    put("mail.mime.multipart.ignoremissingendboundary", "true")
    if (key == "mail.smtp") {
      // Required, not just wanted: without it a stranger on the network could strip the encryption and read the password.
      put("$key.starttls.enable", "true")
      put("$key.starttls.required", "true")
    }
  }
  return Session.getInstance(properties)
}

private fun refusal(error: Exception): CodedException {
  var cause: Throwable? = error
  while (cause != null) {
    if (cause is SSLException) return CodedException("ERR_MAIL_CERTIFICATE", "The connection could not be secured", null)
    cause = cause.cause
  }
  return when (error) {
    is AuthenticationFailedException -> CodedException("ERR_MAIL_AUTH", "The server refused the login", null)
    is SendFailedException -> CodedException("ERR_MAIL_RECIPIENT", "The server refused the mail", null)
    else -> CodedException("ERR_MAIL_SEND", "The mail server could not be used", null)
  }
}

/**
 * The one thing Kamil ever writes to a mailbox: the copy of a mail the student just approved, in the Sent folder that already exists.
 * It creates no folder, and a mailbox with no such folder gets no copy and says so.
 */
private fun keepInSent(mail: OutgoingMail, message: MimeMessage): Boolean {
  val store = session(mail.host, mail.imapPort, "mail.imaps").getStore("imaps")
  try {
    store.connect(mail.user, mail.password)
    val folders = store.defaultFolder.list("*")
    val sent = folders.firstOrNull { folder -> (folder as? IMAPFolder)?.attributes?.any { it.equals("\\Sent", true) } == true }
      ?: SENT_NAMES.firstNotNullOfOrNull { name -> folders.firstOrNull { it.fullName.equals(name, true) || it.name.equals(name, true) } }
      ?: return false
    message.setFlag(Flags.Flag.SEEN, true)
    sent.appendMessages(arrayOf<Message>(message))
    return true
  } finally {
    runCatching { store.close() }
  }
}

/** The Message-ID is written here: by default it would carry the phone's own host name. */
private class Outgoing(session: Session, private val id: String) : MimeMessage(session) {
  override fun updateMessageID() = setHeader("Message-ID", id)
}

/** Connects first, on 587 and then on 465, so that a failed connection can move on but a mail can never go twice. Returns its Message-ID. */
fun sendMail(mail: OutgoingMail): SendResult {
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
  var session = session(mail.host, STARTTLS_PORT, "mail.smtp")
  var transport: Transport = session.getTransport("smtp")
  try {
    try {
      transport.connect(mail.user, mail.password)
    } catch (error: MessagingException) {
      val refused = refusal(error)
      if (refused.code != "ERR_MAIL_SEND") throw refused
      session = session(mail.host, TLS_PORT, "mail.smtps")
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
    return SendResult().apply {
      this.id = id
      // The mail has gone by now, so a failed copy is only reported, never taken for a failed send.
      sentCopy = !mail.saveCopy || runCatching { keepInSent(mail, message) }.getOrDefault(false)
    }
  } catch (error: CodedException) {
    throw error
  } catch (error: MessagingException) {
    throw refusal(error)
  } finally {
    runCatching { transport.close() }
  }
}

// ---- Reading. Opened read-only: the server itself then refuses any change, so unread mail stays unread and nothing can be deleted.

private const val MAX_MAIL_BYTES = 256 * 1024 // enough for any text; attachments beyond it are never fetched
private const val MOST_PER_ROUND = 20 // the phone wakes for a short while, and the rest comes next round
private const val MAX_DEPTH = 6
private const val MAX_PARTS = 40
private const val MAX_ATTACHMENTS = 20
private const val MAX_NAME_CHARS = 120
private val WANTED_HEADERS = listOf("message-id", "references", "in-reply-to", "precedence", "list-unsubscribe", "list-id", "auto-submitted")

private fun <T> inbox(host: String, port: Int, user: String, password: String, work: (IMAPFolder, Session) -> T): T {
  val session = session(host, port, "mail.imaps")
  val store = session.getStore("imaps")
  try {
    store.connect(user, password)
    val folder = store.getFolder("INBOX") as IMAPFolder
    folder.open(Folder.READ_ONLY)
    try {
      return work(folder, session)
    } finally {
      runCatching { folder.close(false) }
    }
  } catch (error: MessagingException) {
    throw refusal(error)
  } finally {
    runCatching { store.close() }
  }
}

fun countInbox(account: MailAccount): Int =
  inbox(account.host, account.port, account.user, account.password) { folder, _ -> folder.messageCount }

private class Found {
  var plain = ""
  var html = ""
  val attachments = mutableListOf<String>()
  var parts = 0
}

private fun textOf(part: Part): String {
  val bytes = part.inputStream.use { it.readBytes() }
  val named = runCatching { ContentType(part.contentType).getParameter("charset") }.getOrNull()
  val charset = runCatching { Charset.forName(MimeUtility.javaCharset(named ?: "UTF-8")) }.getOrDefault(Charsets.UTF_8)
  return String(bytes, charset)
}

/** Text is read and attachments are only named: nothing here opens, decodes or keeps a file. */
private fun walk(part: Part, depth: Int, found: Found) {
  found.parts += 1
  if (depth > MAX_DEPTH || found.parts > MAX_PARTS) return
  if (part.isMimeType("multipart/*") && part is MimePart) {
    val children = MimeMultipart(MimePartDataSource(part))
    for (index in 0 until children.count) runCatching { walk(children.getBodyPart(index), depth + 1, found) }
    return
  }
  val name = runCatching { part.fileName }.getOrNull()
  if (name != null || Part.ATTACHMENT.equals(runCatching { part.disposition }.getOrNull(), true)) {
    if (found.attachments.size < MAX_ATTACHMENTS) found.attachments.add((name ?: "ek").take(MAX_NAME_CHARS))
    return
  }
  if (part.isMimeType("text/plain") && found.plain.isEmpty()) found.plain = textOf(part)
  else if (part.isMimeType("text/html") && found.html.isEmpty()) found.html = textOf(part)
}

private fun parsed(uid: Long, raw: ByteArrayInputStream?, session: Session): Map<String, Any?> {
  val base = mapOf<String, Any?>("uid" to uid.toDouble())
  if (raw == null) return base + ("unreadable" to true)
  return try {
    val message = MimeMessage(session, raw)
    val found = Found()
    runCatching { walk(message, 0, found) }
    val from = runCatching { message.from?.firstOrNull() as? InternetAddress }.getOrNull()
    base + mapOf(
      "subject" to runCatching { message.subject }.getOrNull().orEmpty(),
      "sender" to from?.personal.orEmpty(),
      "from" to from?.address.orEmpty(),
      "date" to runCatching { message.sentDate?.time?.toDouble() }.getOrNull(),
      "plain" to found.plain,
      "html" to found.html,
      "attachments" to found.attachments,
      "headers" to WANTED_HEADERS.mapNotNull { name -> runCatching { message.getHeader(name, " ") }.getOrNull()?.let { name to it } }.toMap(),
    )
  } catch (error: Exception) {
    base + ("unreadable" to true)
  }
}

/**
 * Mail newer than the cursor, oldest first. Without a cursor, all the mail since a date, which the caller stores quietly. A new UIDVALIDITY means the
 * server renumbered the folder, so old numbers mean nothing and reading goes on from the newest mail.
 */
fun readMail(request: ReadRequest): Map<String, Any?> =
  inbox(request.host, request.port, request.user, request.password) { folder, session ->
    val validity = folder.uidValidity
    val next = folder.uidNext
    val lastSeen = request.lastUid?.toLong()
    if (lastSeen != null && request.uidvalidity?.toLong() != validity) {
      return@inbox mapOf("uidvalidity" to validity.toDouble(), "lastUid" to (next - 1).toDouble(), "mails" to emptyList<Any>())
    }
    val messages = if (lastSeen != null) {
      folder.getMessagesByUID(lastSeen + 1, UIDFolder.LASTUID).filterNotNull().toTypedArray()
    } else {
      folder.search(ReceivedDateTerm(ComparisonTerm.GE, Date(request.sinceMs.toLong())))
    }
    folder.fetch(messages, FetchProfile().apply { add(UIDFolder.FetchProfileItem.UID) })
    val ordered = messages.map { it to folder.getUID(it) }
      .filter { (_, uid) -> lastSeen == null || uid > lastSeen }
      .sortedBy { (_, uid) -> uid }
      .let { if (lastSeen != null) it.take(MOST_PER_ROUND) else it }
    val mails = ordered.map { (message, uid) ->
      // The start of the mail only, and PEEK: it stays unread, and a big attachment is never downloaded.
      val body = folder.doCommand(IMAPFolder.ProtocolCommand { protocol ->
        protocol.peekBody(message.messageNumber, "", 0, MAX_MAIL_BYTES)
      }) as? org.eclipse.angus.mail.imap.protocol.BODY
      parsed(uid, body?.byteArrayInputStream, session)
    }
    val newest = ordered.lastOrNull()?.second ?: -1L
    // Mail that arrived after the folder opened may be in this batch already, so the next round must not fetch it again.
    val lastUid = if (lastSeen != null) maxOf(lastSeen, newest) else maxOf(next - 1, newest)
    mapOf("uidvalidity" to validity.toDouble(), "lastUid" to lastUid.toDouble(), "mails" to mails)
  }
