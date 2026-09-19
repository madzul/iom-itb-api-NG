const { Transactions, Merchandises, sequelize } = require('../../models');
const { StatusCodes } = require('http-status-codes');
const BaseError = require('../../schemas/responses/BaseError');
const { decreaseMerchandiseStock } = require('../payments/stockHelper');
const sendEmail = require('../../utils/mailer');
const sendWhatsApp = require('../../utils/whatsapp');
const { buildTransactionProofReceivedEmail } = require('../payments/templates/paymentConfirmation');
const { buildOrderStatusUrl } = require('../payments/templates/emailLayout');
const { generateOrderTrackingToken } = require('../../utils/orderTrackingToken');
const fs = require('fs');
const path = require('path');

const formatIDR = (n) => Number(n || 0).toLocaleString('id-ID');

const notifyTransactionProofReceived = async (trx, merchandiseName) => {
  const amount = formatIDR(trx.grossAmount);
  const orderStatusUrl = buildOrderStatusUrl(trx.publicToken);
  const tasks = [];

  if (trx.noTelp) {
    const message = `Halo ${trx.username}!\n\nBukti pembayaran Anda telah kami terima.\n\nKode Pesanan: ${trx.code}\nProduk: ${merchandiseName} x ${trx.qty}\nTotal: Rp ${amount}\n\nTim IOM ITB akan memverifikasi pembayaran dalam 1x24 jam. Anda dapat memantau status pesanan melalui tautan berikut:\n${orderStatusUrl}\n\nSalam,\nIOM ITB`;
    tasks.push(
      sendWhatsApp(
        trx.noTelp,
        message,
        `transaction-${trx.id}-proof-received`,
        `transaction-${trx.id}`
      )
    );
  }

  if (trx.email) {
    const email = buildTransactionProofReceivedEmail({
      username: trx.username,
      code: trx.code,
      merchandiseName,
      qty: trx.qty,
      amount,
      transactionId: trx.id,
      orderStatusToken: trx.publicToken,
      orderStatusUrl,
    });
    tasks.push(
      sendEmail({
        to: trx.email,
        subject: email.subject,
        html: email.html,
        attachments: email.attachments,
      })
    );
  }

  await Promise.allSettled(tasks);
};

const CreateTransaction = async (body, files, uploadPath) => {
  const imageFile = files && files['payment'] ? files['payment'][0] : null;
  const { merchandiseId, username, email, noTelp, address, qty, notes } = body;

  if (!merchandiseId || !username || !email || !noTelp || !address || qty == null) {
    throw new BaseError({
      status: StatusCodes.BAD_REQUEST,
      message: 'Merchandise ID, username, email, noTelp, address, and qty are required fields',
    });
  }

  const qtyNum = Number(qty);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
    throw new BaseError({
      status: StatusCodes.BAD_REQUEST,
      message: 'qty must be a positive integer',
    });
  }

  const transaction = await sequelize.transaction();
  try {
    const merchandise = await Merchandises.findByPk(merchandiseId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!merchandise) {
      throw new BaseError({
        status: StatusCodes.NOT_FOUND,
        message: 'Merchandise not found',
      });
    }

    await decreaseMerchandiseStock({ merchandiseId, qty: qtyNum }, transaction);

    // Multer (middlewares/multer.js) actually saves uploaded files to
    // src/uploads/, served statically at the /uploads prefix (see app.js) —
    // not /public/images/transactions, which nothing ever writes to.
    const imageFileName = imageFile ? `${uploadPath}/uploads/${imageFile.filename}` : null;
    const grossAmount = Number(merchandise.price) * qtyNum;

    const newTransaction = await Transactions.create(
      {
        username,
        email,
        noTelp,
        address,
        merchandiseId,
        qty: qtyNum,
        payment: imageFileName,
        publicToken: generateOrderTrackingToken(),
        status: 'waiting',
        paymentMethod: 'manual',
        paymentStatus: 'pending',
        grossAmount,
        stockDeducted: true,
        notes: notes || null,
      },
      { transaction }
    );

    newTransaction.code = `IOM-${Date.now()}-${newTransaction.id}`;
    await newTransaction.save({ transaction });

    await transaction.commit();

    notifyTransactionProofReceived(newTransaction, merchandise.name).catch((err) => {
      console.error(`Failed to send proof-received notification for transaction ${newTransaction.id}:`, err.message);
    });

    return {
      code: newTransaction.code,
      message: 'Transaction created successfully',
      orderStatusToken: newTransaction.publicToken,
      orderStatusUrl: buildOrderStatusUrl(newTransaction.publicToken),
    };
  } catch (error) {
    await transaction.rollback();

    if (files && imageFile) {
      const imageFilePath = path.join(__dirname, '../../uploads', imageFile.filename);
      if (fs.existsSync(imageFilePath)) {
        fs.unlinkSync(imageFilePath);
      }
    }

    throw new BaseError({
      status: error.status || StatusCodes.INTERNAL_SERVER_ERROR,
      message: `Failed to create transaction: ${error.message || error}`,
    });
  }
};

module.exports = CreateTransaction;
