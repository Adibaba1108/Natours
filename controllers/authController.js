const jwt = require('jsonwebtoken');
const { promisify } = require('util'); //rather than taking whole util library we take only promise via destructuring
const User = require('./../models/userModel');
const catchAsync = require('./../utils/catchAsync');
const AppError = require('./../utils/appError');
const sendEmail= require('./../utils/email');

//jwt.sign function takes the payload, secret and options as its arguments. The payload can be used to find out which user is the owner of the token. Options can have an expire time until which token is valid.
//The generated token will be a string.We are then sending the generated token back to the client in the response body. The client should preserve this token for future requests.
const signToken = id => {
    // create a JWT using jwt.sign(), which takes an ID and secret as parameters.
   // nothing fancy in secret key, but it should be at least 32 characters long
    return jwt.sign({ id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN
    });
  };
  
//   const createSendToken = (user, statusCode, res) => {
//     const token = signToken(user._id);
//     const cookieOptions = {
//       expires: new Date(
//         Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
//       ),
//       httpOnly: true
//     };
//     if (process.env.NODE_ENV === 'production') cookieOptions.secure = true;
  
//     res.cookie('jwt', token, cookieOptions);
  
//     // Remove password from output
//     user.password = undefined;
  
//     res.status(statusCode).json({
//       status: 'success',
//       token,
//       data: {
//         user
//       }
//     });
//   };
  

//kind of a create tour for the user...
exports.signup = catchAsync(async (req,res, _next) =>{

//we need to be specific in the fields we ask for,thus not used req.body
//But now we can't register as an admin,we have create a new user normally and then add the role via Mongo DB compass
    const newUser = await User.create({
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        passwordConfirm: req.body.passwordConfirm,
        role:req.body.role
    });
     
    const token = signToken(newUser._id);
    
    res.status(201).json({
        status: 'success',
        token,
        data:{
            user: newUser
        }
    });

    //createSendToken(newUser, 201, res);

    
});

exports.login = catchAsync(async (req, res, next) => {
    const { email, password } = req.body; //done via ES6 destructuring
   
    // 1) Check if email and password exist
    
    if (!email || !password) { //sending an error by creating it first and then sending it to our global error handler
      
        return next(new AppError('Please provide email and password!', 400)); //400-:bad request  
        //return as if there is an error we should return right there only
    }

    // 2) Check if user exists && password is correct

    const user = await User.findOne({ email }).select('+password');
   //As password is not visible in output so to select it when the is an email entered exist,we have to write it with "+",to explicitly select it
    
    if (!user || !(await user.correctPassword(password, user.password))) {//We can see here that we used user.correctPass as user variable here is a user doc as we get it via querrying the user model,so we can use the instance method like that.
      
        return next(new AppError('Incorrect email or password', 401));//401 -: unauthorized
    }
  
    //Now some more authentication --a bit of advance from very basic---
    // 3) If everything ok, send token to client

    const token = signToken(user._id);
    
    res.status(200).json({
        status: 'success',
        token,
    });
     
    //createSendToken(user, 200, res);

  });

exports.protect = catchAsync(async(req,_res,next) => {
    //Here the acess part is done in 4 steps when the user loged in the system will have to check that it is a valid user then only it will grant user's acees to all the data the user want,like getallTours.
    //Since GET requests have no request body, we have to send the token as an HTTP header.
    //To keep things consistent, the token will remain in the header for all routes. It’s convention to create header called authorization and set it to 'Bearer jsonwebtokenstringgoeshere'


    // 1) Getting token and check of it's there
    let token;
    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        token = req.headers.authorization.split(' ')[1];//split() req.headers.authorization at the space and then target the second element of the resulting array
    }

    if (!token) {
        return next(
        new AppError('You are not logged in! Please log in to get access.', 401) //401 -: unauthorized
        );
    }

    // 2) Verification token
    //verify() method from the jwt package takes in token and the secret to create a test signature which it will check later
    //function is asynchronous but does not return a promise by default, so we’ll make it return a promise by using the promisify() function from the util module.

    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);// decoded will look like->{ id: '607c879a3f49582e901c8e35', iat: 1618773915, exp: 1626549915 }
    
    //rather than doing try and catch we created a new error in our global error handler file for "JsonWebTokenError" specially.
    //console.log(decoded);

    // // 3) Check if user still exists,If a user logs in but then deletes their account, someone else could potentially gain access to their JWT before it expires.
    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
        return next(
        new AppError(
            'The user belonging to this token does no longer exist.',
            401
        )
        );
    }

    // // 4) Check if user changed password after the token was issued
    if (currentUser.changedPasswordAfter(decoded.iat)) {//as currUser is model doc so we can use the instance method directly on it
        return next(
        new AppError('User recently changed password! Please log in again.', 401)
        );
    }

    // GRANT ACCESS TO PROTECTED ROUTE
    req.user = currentUser;

    next();
});  

exports.restrictTo = (...roles) => {//Normally we cannot pass in our own arguments to a middleware function, but in this situation we need to. The solution is to put our arguments in a wrapper function that returns the middleware function.
    return (req, _res, next) => {
      // roles ['admin', 'lead-guide'].
      //if  role='user'--:
      if (!roles.includes(req.user.role)) {// req.user exists because of the authController.protect middleware from earlier.
        return next(
          new AppError('You do not have permission to perform this action', 403)//403 : forbidden 
        );
      }
  
      next();
    };
  };


  exports.forgotPassword = catchAsync(async (req, res, next) => { // in short just prompts the user for their email address
    // 1) Get user based on POSTed email
    const user = await User.findOne({ email: req.body.email });
    if (!user) {
      return next(new AppError('There is no user with email address.', 404));
    }
  
    // 2) Generate the random reset token,it is different from the jwt that every user have...
    //Here we generate the random reset token, which is like a reset password that the user can use to create a new password
    // we implement an instance function in userModel(thick model analogy)

    const resetToken = user.createPasswordResetToken();
    // we updated the user’s data in that above function,but never actually saved that data to the database
 // ---Very very important---  // Therefore, we need to await the user.save() function. Since we’re skipping over the required fields, we need to pass in { validateBeforeSave: false }.
    await user.save({ validateBeforeSave: false });
    // 3) The next step is to send the reset token to the user via email
    const resetURL = `${req.protocol}://${req.get(
      'host'
    )}/api/v1/users/resetPassword/${resetToken}`;
  
    const message = `Forgot your password? Submit a PATCH request with your new password and passwordConfirm to: ${resetURL}.\nIf you didn't forget your password, please ignore this email!`;
  
    try {
      await sendEmail({
        email: user.email,
        subject: 'Your password reset token (valid for 10 min)',
        message
      });
  
      res.status(200).json({
        status: 'success',
        message: 'Token sent to email!'
      });
    } catch (err) {//we here implemented a try catch because if there is an error then we have to
      // console.log(user.email,resetURL);
      user.passwordResetToken = undefined;//we have to send an error message: we also have to reset the passwordResetToken and passwordResetExpires fields for our user.
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });
  
      return next(
        new AppError('There was an error sending the email. Try again later!'),
        500
      );
    }
  });

  exports.resetPassword = catchAsync(async (req, res, next) => {



  });

 