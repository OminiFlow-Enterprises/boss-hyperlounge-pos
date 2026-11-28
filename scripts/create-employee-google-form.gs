function createEmployeeGoogleForm() {
  const form = FormApp.create('Boss Hyper Lounge Employee Details', false);
  console.log('Edit your draft: ' + form.getEditUrl());

  form.setDescription('Complete this form for Boss Hyper Lounge employee onboarding.');
  form.setPublishingSummary(false);
  form.addTextItem().setTitle('Employee full name').setRequired(true);
  form.addTextItem()
    .setTitle('Employee mobile number')
    .setHelpText('Enter 10 digits, with an optional +91 prefix.')
    .setValidation(FormApp.createTextValidation().requireTextMatchesPattern('^(?:[+]91 ?)?[6-9][0-9]{9}$').build())
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Present address')
    .setHelpText('Include house or flat number, street, city, state, and PIN code.')
    .setRequired(true);
  form.addCheckboxItem()
    .setTitle('Are your present and permanent addresses the same?')
    .setChoiceValues(['My permanent address is the same as my present address.']);
  form.addParagraphTextItem()
    .setTitle('Permanent address')
    .setHelpText('Enter your complete permanent address if it differs from your present address.');

  form.addTextItem()
    .setTitle('Aadhaar number (last 4 digits only)')
    .setHelpText('Optional. Enter only the last four digits shown on your masked Aadhaar.')
    .setValidation(FormApp.createTextValidation().requireTextMatchesPattern('^[0-9]{4}$').build());
  form.addTextItem()
    .setTitle('PAN number')
    .setHelpText('Enter your 10-character PAN in uppercase, for example ABCDE1234F.')
    .setValidation(FormApp.createTextValidation().requireTextMatchesPattern('^[A-Z]{5}[0-9]{4}[A-Z]$').build())
    .setRequired(true);
}
